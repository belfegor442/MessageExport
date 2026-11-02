/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";

import { setAttachmentState, type StoredAttachment, type StoredMessage } from "../core/db";
import { logEvent } from "../core/events";
import { attachmentCategory } from "../derived/writer";
import { settings } from "../settings";
import { logger } from "../utils/logger";
import { Native } from "../utils/nativeBridge";
import { sanitizeSegment } from "../utils/sanitize";

const DOWNLOAD_DELAY_MS = 350;

interface QueueItem {
    root: string;
    message: StoredMessage;
    attachment: StoredAttachment;
}

let queue: QueueItem[] = [];
const queuedKeys = new Set<string>();
let drainPromise: Promise<void> | null = null;
let downloaded = 0;
let failed = 0;

export function clearDownloadQueue(): void {
    queue = [];
    queuedKeys.clear();
}

export function resetAttachmentStats(): void {
    downloaded = 0;
    failed = 0;
}

export function getAttachmentStats(): { downloaded: number; failed: number; } {
    return { downloaded, failed };
}

export function enqueueAttachment(root: string, message: StoredMessage, attachment: StoredAttachment): void {
    if (attachment.downloadState !== "pending" || !attachment.url) return;

    const key = `${message.channelId}:${message.id}:${attachment.id}`;
    if (queuedKeys.has(key)) return;
    queuedKeys.add(key);
    queue.push({ root, message, attachment });
    if (!drainPromise)
        drainPromise = drain()
            .catch(e => logger.error("Attachment download loop failed", e))
            .finally(() => { drainPromise = null; });
}

/** Resolves once no download is in flight (the queue itself is dropped by clearDownloadQueue). */
export async function awaitIdleDownloads(): Promise<void> {
    while (drainPromise)
        await drainPromise;
}

async function drain(): Promise<void> {
    while (queue.length > 0) {
        if (!settings.store.downloadAttachments) {
            clearDownloadQueue();
            break;
        }
        const item = queue.shift()!;
        queuedKeys.delete(`${item.message.channelId}:${item.message.id}:${item.attachment.id}`);
        await downloadOne(item);
        if (queue.length > 0)
            await sleep(DOWNLOAD_DELAY_MS);
    }
}

async function downloadOne(item: QueueItem): Promise<void> {
    const { root, message, attachment } = item;
    const base = `Attachments/${attachmentCategory(attachment.contentType, attachment.filename)}`;
    const filename = sanitizeSegment(attachment.filename);

    try {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        if (data.byteLength === 0) throw new Error("empty response body");

        let relPath = `${base}/${message.id}-${filename}`;
        const existing = await Native.stat(root, relPath).catch(() => null);
        if (existing)
            relPath = `${base}/${message.id}-${attachment.id.slice(0, 8)}-${filename}`;

        await Native.writeBinary(root, relPath, data);
        await setAttachmentState(message.channelId, message.id, attachment.id, {
            localPath: relPath,
            downloadState: "downloaded"
        });
        downloaded++;
        logEvent(root, "attachment_downloaded", {
            channelId: message.channelId,
            messageId: message.id,
            attachmentId: attachment.id,
            path: relPath,
            bytes: data.byteLength
        });
    } catch (e) {
        failed++;
        await setAttachmentState(message.channelId, message.id, attachment.id, {
            localPath: null,
            downloadState: "failed"
        }).catch(() => { });
        logEvent(root, "attachment_failed", {
            channelId: message.channelId,
            messageId: message.id,
            attachmentId: attachment.id,
            error: e instanceof Error ? e.message : String(e)
        });
        logger.warn(`Attachment download failed for ${attachment.filename}`, e);
    }
}
