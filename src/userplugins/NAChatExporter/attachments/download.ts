/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";

import {
    getAllConversations,
    getConversation,
    iterateChannelMessages,
    setAttachmentState,
    type StoredAttachment,
    type StoredMessage
} from "../core/db";
import { logEvent } from "../core/events";
import { emitChanged } from "../core/hooks";
import { attachmentCategory, resolveConversationDir } from "../derived/writer";
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
    if (!settings.store.downloadSelectedAttachments || !getSelectedGuildIds().size
        || attachment.downloadState !== "pending" || !attachment.url) return;

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
        if (!settings.store.downloadSelectedAttachments) {
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
    const filename = sanitizeSegment(attachment.filename);

    try {
        if (!settings.store.downloadSelectedAttachments)
            return;

        const conversation = await getConversation(message.channelId);
        if (!settings.store.downloadSelectedAttachments || !conversation?.guildId
            || !getSelectedGuildIds().has(conversation.guildId))
            return;

        const conversationDir = await resolveConversationDir(root, conversation);
        const relPath = `${conversationDir}/Attachments/${attachmentCategory(attachment.contentType, attachment.filename)}/${message.id}-${attachment.id}-${filename}`;
        const existing = await Native.stat(root, relPath).catch(() => null);
        if (existing) {
            const updated = await setAttachmentState(message.channelId, message.id, attachment.id, {
                localPath: relPath,
                downloadState: "downloaded"
            });
            if (updated) emitChanged(message.channelId);
            return;
        }

        const bytes = await Native.downloadAttachment(root, relPath, attachment.url);
        const updated = await setAttachmentState(message.channelId, message.id, attachment.id, {
            localPath: relPath,
            downloadState: "downloaded"
        });
        if (updated) emitChanged(message.channelId);
        downloaded++;
        logEvent(root, "attachment_downloaded", {
            channelId: message.channelId,
            messageId: message.id,
            attachmentId: attachment.id,
            path: relPath,
            bytes
        });
    } catch (e) {
        failed++;
        const updated = await setAttachmentState(message.channelId, message.id, attachment.id, {
            localPath: null,
            downloadState: "failed"
        }).catch(() => { });
        if (updated) emitChanged(message.channelId);
        logEvent(root, "attachment_failed", {
            channelId: message.channelId,
            messageId: message.id,
            attachmentId: attachment.id,
            error: e instanceof Error ? e.message : String(e)
        });
        logger.warn(`Attachment download failed for ${attachment.filename}`, e);
    }
}

function getSelectedGuildIds(): Set<string> {
    return new Set(
        settings.store.attachmentGuildIds
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)
    );
}

export async function scanPendingAttachments(root: string): Promise<void> {
    if (!settings.store.downloadSelectedAttachments || !getSelectedGuildIds().size) {
        clearDownloadQueue();
        return;
    }

    const selectedGuildIds = getSelectedGuildIds();
    for (const conversation of await getAllConversations()) {
        if (!conversation.guildId || !selectedGuildIds.has(conversation.guildId)) continue;
        await iterateChannelMessages(conversation.id, batch => {
            for (const message of batch) {
                for (const attachment of message.attachments)
                    enqueueAttachment(root, message, attachment);
            }
        }, 200);
    }
}
