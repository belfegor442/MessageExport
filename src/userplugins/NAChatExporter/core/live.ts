/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { logger } from "../utils/logger";
import {
    applyReactionState,
    clearReactions,
    getMessage,
    getMessageById,
    insertMessagesIfAbsent,
    markMessageDeleted,
    patchMessage,
    recordEdit,
    recordReactionEvent,
    upsertConversation,
} from "./db";
import { logEvent } from "./events";
import { emitDeleted, emitEdited, emitStored, isArchivingActive } from "./hooks";
import { describeChannelById } from "./registry";
import { isChannelInArchiveScope } from "./scope";

interface MessageCreateEvent { message: any; channelId?: string; }
interface MessageUpdateEvent { message: any; }
interface MessageDeleteEvent { id: string; channelId?: string; }
interface MessageDeleteBulkEvent { ids: string[]; channelId: string; }
interface ReactionEvent {
    channelId: string;
    messageId: string;
    emoji: { id?: string | null; name?: string; animated?: boolean; };
    userId?: string;
    count?: number;
}
interface ReactionRemoveAllEvent { channelId: string; messageId: string; }
interface VoiceStateEvent {
    userId: string;
    channelId?: string | null;
    oldChannelId?: string | null;
    selfVideo?: boolean;
    selfStream?: boolean;
}

let root = "";

export function setLiveLogRoot(next: string): void {
    root = next;
}

async function ensureConversation(channelId: string): Promise<void> {
    const descriptor = describeChannelById(channelId);
    if (descriptor) {
        await upsertConversation(descriptor);
        return;
    }
    // Channel not in stores (e.g. uncached thread): persist a minimal record so the message is not lost
    await upsertConversation({ id: channelId, name: channelId });
}

export async function handleMessageCreate(event: MessageCreateEvent): Promise<void> {
    if (!isArchivingActive()) return;
    const { message } = event;
    if (!message?.id) return;
    const channelId = String(message.channel_id ?? event.channelId ?? "");
    if (!channelId || !await isChannelInArchiveScope(channelId)) return;

    try {
        await ensureConversation(channelId);
        const result = await insertMessagesIfAbsent([message], "live");
        if (result.inserted > 0) {
            logEvent(root, "message_captured", { channelId, messageId: message.id, source: "live" });
            for (const stored of result.stored)
                emitStored(stored);
        }
    } catch (e) {
        logger.error("Failed to persist live message", e);
    }
}

export async function handleMessageUpdate(event: MessageUpdateEvent): Promise<void> {
    if (!isArchivingActive()) return;
    const { message } = event;
    if (!message?.id) return;
    const channelId = String(message.channel_id ?? "");
    const messageId = String(message.id);
    if (!channelId || !await isChannelInArchiveScope(channelId)) return;

    try {
        const editedTimestamp = message.edited_timestamp ?? message.editedTimestamp ?? null;
        const newContent = String(message.content ?? "");
        const stored = await getMessage(channelId, messageId);

        if (!stored) {
            // Not captured yet (e.g. edited while plugin was off): persist current state as-is
            const inserted = await insertMessagesIfAbsent([message], "live");
            for (const storedMessage of inserted.stored) {
                logEvent(root, "message_captured", { channelId, messageId, source: "live_update" });
                emitStored(storedMessage);
            }
            return;
        }

        if (stored.content !== newContent) {
            await recordEdit(channelId, messageId, newContent, editedTimestamp ? Date.parse(editedTimestamp) : null);
            logEvent(root, "message_edited", { channelId, messageId });
            emitEdited(channelId, messageId);
        } else if (stored.pinned !== Boolean(message.pinned)) {
            await patchMessage(channelId, messageId, m => {
                m.pinned = Boolean(message.pinned);
                return true;
            });
        }
    } catch (e) {
        logger.error("Failed to process message update", e);
    }
}

export async function handleMessageDelete(event: MessageDeleteEvent): Promise<void> {
    if (!isArchivingActive()) return;
    const id = String(event.id ?? "");
    if (!id) return;
    try {
        let channelId = event.channelId ?? "";
        if (!channelId) {
            const existing = await getMessageById(id).catch(() => undefined);
            channelId = existing?.channelId ?? "";
        }
        if (!channelId || !await isChannelInArchiveScope(channelId)) return;
        const outcome = await markMessageDeleted(channelId, id);
        if (outcome === "deleted") {
            logEvent(root, "message_deleted", { channelId: channelId || null, messageId: id });
            emitDeleted(channelId, id);
        } else
            logEvent(root, "delete_unstored", { channelId: channelId || null, messageId: id });
    } catch (e) {
        logger.error("Failed to process message delete", e);
    }
}

export async function handleMessageDeleteBulk(event: MessageDeleteBulkEvent): Promise<void> {
    for (const id of event.ids ?? [])
        await handleMessageDelete({ id, channelId: event.channelId });
}

export async function handleReactionAdd(event: ReactionEvent): Promise<void> {
    if (!isArchivingActive() || !await isChannelInArchiveScope(event.channelId)) return;
    try {
        const applied = await applyReactionState(
            event.channelId,
            event.messageId,
            event.emoji,
            "add",
            event.userId ?? null,
            typeof event.count === "number" ? event.count : null
        );
        await recordReactionEvent(event.channelId, event.messageId, event.emoji, "add", event.userId ?? null);
        if (!applied)
            logEvent(root, "reaction_on_unstored", { channelId: event.channelId, messageId: event.messageId });
    } catch (e) {
        logger.error("Failed to process reaction add", e);
    }
}

export async function handleReactionRemove(event: ReactionEvent): Promise<void> {
    if (!isArchivingActive() || !await isChannelInArchiveScope(event.channelId)) return;
    try {
        await applyReactionState(
            event.channelId,
            event.messageId,
            event.emoji,
            "remove",
            event.userId ?? null,
            typeof event.count === "number" ? event.count : null
        );
        await recordReactionEvent(event.channelId, event.messageId, event.emoji, "remove", event.userId ?? null);
    } catch (e) {
        logger.error("Failed to process reaction remove", e);
    }
}

export async function handleReactionRemoveAll(event: ReactionRemoveAllEvent): Promise<void> {
    if (!isArchivingActive() || !await isChannelInArchiveScope(event.channelId)) return;
    try {
        await clearReactions(event.channelId, event.messageId);
        await recordReactionEvent(event.channelId, event.messageId, {}, "clear", null);
    } catch (e) {
        logger.error("Failed to process reaction clear", e);
    }
}

export async function handleVoiceStateUpdate(event: { voiceStates: VoiceStateEvent[]; }): Promise<void> {
    if (!isArchivingActive()) return;
    for (const state of event.voiceStates ?? []) {
        if (!state.userId) continue;
        const relevantChannelId = state.channelId ?? state.oldChannelId;
        if (!relevantChannelId || !await isChannelInArchiveScope(relevantChannelId)) continue;
        const type = state.channelId && !state.oldChannelId
            ? "voice_join"
            : !state.channelId && state.oldChannelId
                ? "voice_leave"
                : state.channelId && state.oldChannelId
                    ? "voice_move"
                    : null;
        if (!type) continue;
        logEvent(root, "voice_state", {
            type,
            userId: state.userId,
            channelId: state.channelId ?? null,
            oldChannelId: state.oldChannelId ?? null,
            camera: Boolean(state.selfVideo),
            stream: Boolean(state.selfStream)
        });
    }
}
