/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { IpcMainInvokeEvent } from "electron";
import { appendFile, mkdir, readFile, rename as fsRename, rm, stat as fsStat, writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";

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
export async function writeBinary(_event: IpcMainInvokeEvent, root: string, relPath: string, data: Uint8Array): Promise<void> {
    const target = safeJoin(root, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
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
