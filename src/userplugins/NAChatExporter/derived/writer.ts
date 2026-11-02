/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType } from "@vencord/discord-types/enums";

import {
    getMessage,
    getMeta,
    getVersions,
    iterateAuthorMessages,
    iterateChannelMessages,
    setMeta,
    type StoredAuthor,
    type StoredConversation,
    type StoredMessage,
} from "../core/db";
import { Native } from "../utils/nativeBridge";
import { sanitizeSegment } from "../utils/sanitize";
import { formatDeletionMarker, formatEditMarker, formatMessageLine, formatTimestamp } from "./format";

type Owners = Record<string, string>;

let cachedOwners: Owners | null = null;

async function claimPath(root: string, preferred: string, ownerId: string): Promise<string> {
    if (!cachedOwners) cachedOwners = await getMeta<Owners>("pathOwners") ?? {};
    const owner = cachedOwners[preferred];
    if (owner === ownerId) return preferred;
    if (!owner) {
        cachedOwners[preferred] = ownerId;
        await setMeta("pathOwners", cachedOwners);
        return preferred;
    }
    const suffix = ownerId.slice(-4);
    const unique = `${preferred}-${suffix}`;
    cachedOwners[unique] = ownerId;
    await setMeta("pathOwners", cachedOwners);
    return unique;
}

export function attachmentCategory(contentType: string | null, filename: string): string {
    const type = (contentType ?? "").toLowerCase();
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) return "Images";
    if (type.startsWith("video/") || ["mp4", "webm", "mov", "mkv"].includes(ext)) return "Videos";
    if (type.startsWith("audio/") || ["ogg", "mp3", "wav", "flac", "m4a"].includes(ext)) return "Audio";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext) || type.startsWith("application/zip")) return "Documents";
    if (type.startsWith("application/") || type.startsWith("text/")) return "Documents";
    return "Other";
}

export async function resolveConversationDir(root: string, conversation: StoredConversation): Promise<string> {
    if (conversation.isDM && conversation.type === ChannelType.DM) {
        const other = conversation.recipients[0];
        const name = other?.globalName ?? other?.username ?? conversation.name;
        return claimPath(root, `Conversations/Direct-Messages/${sanitizeSegment(name)}`, conversation.id);
    }
    if (conversation.type === ChannelType.GROUP_DM)
        return claimPath(root, `Conversations/Group-Chats/${sanitizeSegment(conversation.name)}`, conversation.id);

    const guild = sanitizeSegment(conversation.guildName ?? "Unknown-Server");
    const channel = sanitizeSegment(conversation.name);
    return claimPath(root, `Conversations/Servers/${guild}/Channels/${channel}`, conversation.id);
}

export async function appendMessagesToTxt(root: string, path: string, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const lines: string[] = [];
    for (const message of messages) {
        let referenced: StoredMessage | undefined;
        if (message.messageReference)
            referenced = await getMessage(message.messageReference.channelId, message.messageReference.messageId);
        lines.push(...await formatMessageLine(message, referenced));
    }
    await Native.append(root, path, lines.join("\n") + "\n");
}

export async function appendMarkerToTxt(root: string, path: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    await Native.append(root, path, lines.join("\n") + "\n");
}

export function buildDeletionMarkerLines(message: StoredMessage): string[] {
    return formatDeletionMarker(message);
}

export async function buildEditMarkerLines(message: StoredMessage): Promise<string[]> {
    const versions = await getVersions(message.channelId, message.id);
    const last = versions[versions.length - 1];
    return formatEditMarker(message, versions, last?.editedAtMs ?? null);
}

/** Streams the whole conversation from the database into Chat.json without loading it in memory. */
export async function rebuildConversationJson(root: string, dir: string, conversation: StoredConversation): Promise<number> { const tmpPath = `${dir}/Chat.json.tmp`;
    await Native.remove(root, tmpPath).catch(() => { });
    let count = 0;
    let first = true;

    await iterateChannelMessages(conversation.id, batch => {
        const chunk = batch.map(m => JSON.stringify(m)).join(",\n");
        const prefix = first ? "[\n" : ",\n";
        first = false;
        count += batch.length;
        return Native.append(root, tmpPath, prefix + chunk);
    });

    await Native.append(root, tmpPath, first ? "[]\n" : "\n]\n");
    await Native.rename(root, tmpPath, `${dir}/Chat.json`);
    return count;
}

/**
 * Rewrites Chat.txt from the database (tmp + rename). Used when messages arrived
 * out of chronological order (history recovery) so the append cursor can't be trusted.
 * Returns the newest message written, or undefined when the conversation is empty.
 */
export async function rebuildConversationTxt(root: string, dir: string, conversation: StoredConversation): Promise<StoredMessage | undefined> {
    const tmpPath = `${dir}/Chat.txt.tmp`;
    await Native.remove(root, tmpPath).catch(() => { });
    let last: StoredMessage | undefined;

    await iterateChannelMessages(conversation.id, batch =>
        appendMessagesToTxt(root, tmpPath, batch).then(() => { last = batch[batch.length - 1]; }), 500);

    await Native.rename(root, tmpPath, `${dir}/Chat.txt`);
    return last;
}

export async function rebuildConversationCsv(root: string, dir: string, conversation: StoredConversation): Promise<boolean> {
    const tmpPath = `${dir}/Chat.csv.tmp`;
    await Native.remove(root, tmpPath).catch(() => { });
    let first = true;

    await iterateChannelMessages(conversation.id, batch => {
        const rows = batch.map(m => [
            m.id,
            m.channelId,
            new Date(m.timestampMs).toISOString(),
            m.authorId,
            JSON.stringify(m.authorName),
            JSON.stringify(m.content),
            m.edited ? "true" : "false",
            m.deleted ? "true" : "false",
            String(m.attachments.length),
            m.messageReference?.messageId ?? ""
        ].join(","));
        if (first) {
            rows.unshift("id,channel_id,timestamp,author_id,author_name,content,edited,deleted,attachment_count,reply_to");
            first = false;
        }
        return Native.append(root, tmpPath, rows.join("\n") + "\n");
    });

    await Native.rename(root, tmpPath, `${dir}/Chat.csv`);
    return true;
}

export async function rebuildAuthorFiles(root: string, author: StoredAuthor): Promise<void> {
    const dir = await claimPath(root, `Users/${sanitizeSegment(author.globalName ?? author.username)}`, author.id);
    const profile = {
        id: author.id,
        username: author.username,
        globalName: author.globalName,
        nameHistory: author.nameHistory,
        firstSeen: new Date(author.firstSeenMs).toISOString(),
        lastSeen: new Date(author.lastSeenMs).toISOString()
    };
    await Native.writeAtomic(root, `${dir}/Profile.json`, JSON.stringify(profile, null, 2));

    const tmpTxt = `${dir}/Chat.txt.tmp`;
    const tmpJson = `${dir}/Chat.json.tmp`;
    await Native.remove(root, tmpTxt).catch(() => { });
    await Native.remove(root, tmpJson).catch(() => { });
    let firstJson = true;

    await iterateAuthorMessages(author.id, async batch => {
        const sorted = [...batch].sort((a, b) => a.timestampMs - b.timestampMs || (a.id < b.id ? -1 : 1));
        const txt = sorted
            .map(m => `[${formatTimestamp(m.timestampMs)}] ${m.authorName}: ${m.content.replace(/\r?\n/g, " ")}`)
            .join("\n") + "\n";
        const chunk = sorted.map(m => JSON.stringify(m)).join(",\n");
        const prefix = firstJson ? "[\n" : ",\n";
        firstJson = false;
        await Promise.all([
            Native.append(root, tmpTxt, txt),
            Native.append(root, tmpJson, prefix + chunk)
        ]);
    });

    await Native.append(root, tmpJson, firstJson ? "[]\n" : "\n]\n");
    await Native.rename(root, tmpTxt, `${dir}/Chat.txt`);
    await Native.rename(root, tmpJson, `${dir}/Chat.json`);
}
