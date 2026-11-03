/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";
import { appendFile, mkdir, open, readFile, rename as fsRename, rm, stat as fsStat, writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";

const ATTACHMENT_HOSTS = new Set([
    "cdn.discordapp.com",
    "cdn.discordapp.net",
    "media.discordapp.net"
]);

function safeJoin(root: string, relPath: string): string {
    const absRoot = resolve(root);
    const target = resolve(absRoot, relPath);
    if (target === absRoot || !target.startsWith(absRoot + sep))
        throw new Error(`Path escapes the archive root: ${relPath}`);
    return target;
}

export async function ensureLayout(_event: IpcMainInvokeEvent, root: string, dirs: string[]): Promise<void> {
    await mkdir(resolve(root), { recursive: true });
    for (const dir of dirs)
        await mkdir(safeJoin(root, dir), { recursive: true });
}

export async function append(_event: IpcMainInvokeEvent, root: string, relPath: string, data: string): Promise<void> {
    const target = safeJoin(root, relPath);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, data, "utf8");
}

export async function writeAtomic(_event: IpcMainInvokeEvent, root: string, relPath: string, data: string): Promise<void> {
    const target = safeJoin(root, relPath);
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, data, "utf8");
    await fsRename(tmp, target);
}

// Binary write for attachments; creates the parent directory inside the archive root
export async function downloadAttachment(_event: IpcMainInvokeEvent, root: string, relPath: string, url: string): Promise<number> {
    let currentUrl = new URL(url);
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects++) {
        if (currentUrl.protocol !== "https:" || !ATTACHMENT_HOSTS.has(currentUrl.hostname.toLowerCase()))
            throw new Error(`Attachment URL host is not allowed: ${currentUrl.hostname}`);

        response = await fetch(currentUrl, {
            redirect: "manual",
            signal: AbortSignal.timeout(120_000)
        });
        if (![301, 302, 303, 307, 308].includes(response.status))
            break;

        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 3)
            throw new Error("Attachment download exceeded the redirect limit");
        currentUrl = new URL(location, currentUrl);
    }

    if (!response?.ok)
        throw new Error(`Attachment request failed: HTTP ${response?.status ?? "unknown"}`);
    if (!response.body)
        throw new Error("Attachment response has no body");

    const target = safeJoin(root, relPath);
    const tmpPath = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });

    const file = await open(tmpPath, "w");
    let bytes = 0;
    let closed = false;
    let complete = false;

    try {
        const reader = response.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                let offset = 0;
                while (offset < value.byteLength) {
                    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
                    if (bytesWritten === 0)
                        throw new Error("Attachment file write made no progress");
                    offset += bytesWritten;
                }
                bytes += value.byteLength;
            }
        } finally {
            reader.releaseLock();
        }

        closed = true;
        await file.close();
        if (bytes === 0)
            throw new Error("Attachment response body is empty");
        await fsRename(tmpPath, target);
        complete = true;
        return bytes;
    } finally {
        if (!closed) {
            closed = true;
            await file.close();
        }
        if (!complete)
            await rm(tmpPath, { force: true });
    }
}

// Renames within the archive root; used to commit chunk-built files atomically
export async function rename(_event: IpcMainInvokeEvent, root: string, fromRel: string, toRel: string): Promise<void> {
    await fsRename(safeJoin(root, fromRel), safeJoin(root, toRel));
}

export async function remove(_event: IpcMainInvokeEvent, root: string, relPath: string): Promise<void> {
    await rm(safeJoin(root, relPath), { force: true });
}

export async function read(_event: IpcMainInvokeEvent, root: string, relPath: string): Promise<string | null> {
    try {
        return await readFile(safeJoin(root, relPath), "utf8");
    } catch (e: any) {
        if (e?.code === "ENOENT") return null;
        throw e;
    }
}

export async function stat(_event: IpcMainInvokeEvent, root: string, relPath: string): Promise<{ size: number; mtimeMs: number; } | null> {
    try {
        const info = await fsStat(safeJoin(root, relPath));
        return { size: info.size, mtimeMs: info.mtimeMs };
    } catch (e: any) {
        if (e?.code === "ENOENT") return null;
        throw e;
    }
}
