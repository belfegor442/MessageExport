/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const DB_NAME = "NAChatExporterArchive";
const DB_VERSION = 1;

export interface StoredAttachment {
    id: string;
    filename: string;
    size: number;
    contentType: string | null;
    url: string;
    width?: number;
    height?: number;
    durationMs?: number;
    localPath: string | null;
    downloadState: "pending" | "downloaded" | "failed" | "skipped";
}

export interface StoredEmbed {
    type: string;
    url: string | null;
    title: string | null;
    description: string | null;
    color: string | null;
    provider: string | null;
    authorName: string | null;
    footerText: string | null;
    imageUrl: string | null;
    videoUrl: string | null;
    thumbnailUrl: string | null;
    fields: { name: string; value: string; inline: boolean; }[];
}

export interface StoredSticker {
    id: string;
    name: string;
    formatType: number | null;
}

export interface StoredReaction {
    emojiId: string | null;
    name: string;
    animated: boolean;
    count: number;
}

export interface StoredPoll {
    question: string;
    answers: { id: number; text: string; }[];
    expiryMs: number | null;
    allowMultiselect: boolean;
}

export interface StoredMessage {
    channelId: string;
    id: string;
    authorId: string;
    authorName: string;
    authorUsername: string;
    guildNick: string | null;
    timestampMs: number;
    content: string;
    edited: boolean;
    editCount: number;
    deleted: boolean;
    deletedAtMs: number | null;
    type: number;
    flags: number;
    pinned: boolean;
    mentionsEveryone: boolean;
    mentions: string[];
    mentionRoles: string[];
    messageReference: { channelId: string; messageId: string; guildId: string | null; } | null;
    attachments: StoredAttachment[];
    embeds: StoredEmbed[];
    stickers: StoredSticker[];
    reactions: StoredReaction[];
    poll: StoredPoll | null;
    source: "backfill" | "live";
    capturedAtMs: number;
}

export interface StoredMessageVersion {
    channelId: string;
    messageId: string;
    version: number;
    content: string;
    editedAtMs: number | null;
    capturedAtMs: number;
}

export interface StoredReactionEvent {
    channelId: string;
    messageId: string;
    emojiId: string | null;
    emojiName: string;
    action: "add" | "remove" | "clear";
    userId: string | null;
    atMs: number;
}

export interface StoredAuthor {
    id: string;
    username: string;
    globalName: string | null;
    nameHistory: { name: string; username: string; changedAtMs: number; }[];
    firstSeenMs: number;
    lastSeenMs: number;
}

export interface StoredConversation {
    id: string;
    type: number;
    name: string;
    guildId: string | null;
    guildName: string | null;
    isDM: boolean;
    recipients: { id: string; username: string; globalName: string | null; }[];
    backfillStatus: "pending" | "in_progress" | "complete" | "error";
    backfillBefore: string | null;
    backfillFailures: number;
    lastErrorCode: string | null;
    lastMessageId: string | null;
    lastMessageTimestampMs: number | null;
    messageCount: number;
    txtCursorMs: number;
    txtCursorId: string | null;
    txtNeedsRebuild: boolean;
    jsonDirty: boolean;
    /** Bumped on every content mutation; guards conditional flag clears against races */
    contentVersion: number;
    updatedAtMs: number;
}

export interface InsertResult {
    inserted: number;
    skipped: number;
    stored: StoredMessage[];
}

export type DeleteLookup = "deleted" | "not_found";

let dbPromise: Promise<IDBDatabase> | undefined;

function promisifyRequest<T>(request: IDBRequest<T> | IDBTransaction): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = request as IDBRequest<T> & IDBTransaction;
        req.oncomplete = req.onsuccess = () => resolve(req.result as T);
        req.onabort = req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
}

function upgradeDatabase(db: IDBDatabase) {
    if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: ["channelId", "id"] });
        messages.createIndex("by_messageId", "id");
        messages.createIndex("by_channel_time", ["channelId", "timestampMs"]);
        messages.createIndex("by_author", "authorId");
    }
    if (!db.objectStoreNames.contains("versions")) {
        const versions = db.createObjectStore("versions", { keyPath: ["channelId", "messageId", "version"] });
        versions.createIndex("by_message", ["channelId", "messageId"]);
    }
    if (!db.objectStoreNames.contains("reactions")) {
        const reactions = db.createObjectStore("reactions", { keyPath: "autoId", autoIncrement: true });
        reactions.createIndex("by_message", ["channelId", "messageId"]);
    }
    if (!db.objectStoreNames.contains("conversations"))
        db.createObjectStore("conversations", { keyPath: "id" });
    if (!db.objectStoreNames.contains("authors"))
        db.createObjectStore("authors", { keyPath: "id" });
    if (!db.objectStoreNames.contains("meta"))
        db.createObjectStore("meta", { keyPath: "key" });
}

export function openDatabase(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => upgradeDatabase(request.result);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("Failed to open the archive database"));
            request.onblocked = () => reject(new Error("Archive database upgrade blocked by another tab"));
        });
    }
    return dbPromise;
}

export async function closeDatabase(): Promise<void> {
    if (!dbPromise) return;
    const pending = dbPromise;
    dbPromise = undefined;
    const db = await pending;
    db.close();
}

function toMs(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
}

function normalizeAttachment(a: any): StoredAttachment {
    return {
        id: String(a.id ?? ""),
        filename: String(a.filename ?? "attachment"),
        size: Number(a.size ?? 0),
        contentType: a.content_type ?? a.contentType ?? null,
        url: String(a.url ?? ""),
        width: a.width,
        height: a.height,
        durationMs: a.duration_ms ?? a.duration,
        localPath: null,
        downloadState: "pending"
    };
}

function normalizeEmbed(e: any): StoredEmbed {
    return {
        type: String(e.type ?? "rich"),
        url: e.url ?? null,
        title: e.title ?? e.rawTitle ?? null,
        description: e.description ?? e.rawDescription ?? null,
        color: e.color ?? null,
        provider: e.provider?.name ?? null,
        authorName: e.author?.name ?? null,
        footerText: e.footer?.text ?? null,
        imageUrl: e.image?.url ?? e.thumbnail?.url ?? null,
        videoUrl: e.video?.url ?? null,
        thumbnailUrl: e.thumbnail?.url ?? null,
        fields: (e.fields ?? []).map((f: any) => ({
            name: String(f.name ?? f.rawName ?? ""),
            value: String(f.value ?? f.rawValue ?? ""),
            inline: Boolean(f.inline)
        }))
    };
}

function normalizePoll(p: any): StoredPoll {
    return {
        question: String(p.question?.text ?? ""),
        answers: (p.answers ?? []).map((a: any) => ({
            id: Number(a.answer_id ?? 0),
            text: String(a.poll_media?.text ?? "")
        })),
        expiryMs: p.expiry ? toMs(p.expiry) : null,
        allowMultiselect: Boolean(p.allow_multiselect)
    };
}

export function normalizeMessage(raw: any, source: "backfill" | "live"): StoredMessage {
    const author = raw.author ?? {};
    const globalName: string | null = author.global_name ?? author.globalName ?? null;
    const username = String(author.username ?? "");
    const reference = raw.message_reference ?? raw.messageReference ?? null;
    const editedTimestamp = raw.edited_timestamp ?? raw.editedTimestamp ?? null;
    const stickers = raw.stickerItems ?? raw.stickers ?? [];

    return {
        channelId: String(raw.channel_id ?? raw.channelId ?? ""),
        id: String(raw.id ?? ""),
        authorId: String(author.id ?? ""),
        authorName: globalName ?? username,
        authorUsername: username,
        guildNick: typeof raw.member?.nick === "string" ? raw.member.nick : null,
        timestampMs: toMs(raw.timestamp),
        content: String(raw.content ?? ""),
        edited: editedTimestamp != null,
        editCount: 0,
        deleted: false,
        deletedAtMs: null,
        type: Number(raw.type ?? 0),
        flags: Number(raw.flags ?? 0),
        pinned: Boolean(raw.pinned),
        mentionsEveryone: Boolean(raw.mention_everyone ?? raw.mentionEveryone),
        mentions: (raw.mentions ?? []).map((m: any) => String(typeof m === "string" ? m : m.id)),
        mentionRoles: (raw.mention_roles ?? raw.mentionRoles ?? []).map(String),
        messageReference: reference
            ? {
                channelId: String(reference.channel_id ?? reference.channelId ?? ""),
                messageId: String(reference.message_id ?? reference.messageId ?? ""),
                guildId: reference.guild_id ?? reference.guildId ?? null
            }
            : null,
        attachments: (raw.attachments ?? []).map(normalizeAttachment),
        embeds: (raw.embeds ?? []).map(normalizeEmbed),
        stickers: stickers.map((s: any) => ({
            id: String(s.id ?? ""),
            name: String(s.name ?? ""),
            formatType: s.format_type ?? s.formatType ?? null
        })),
        reactions: (raw.reactions ?? []).map((r: any) => ({
            emojiId: r.emoji?.id ?? null,
            name: String(r.emoji?.name ?? ""),
            animated: Boolean(r.emoji?.animated),
            count: Number(r.count ?? 0)
        })),
        poll: raw.poll ? normalizePoll(raw.poll) : null,
        source,
        capturedAtMs: Date.now()
    };
}

export async function insertMessagesIfAbsent(rawMessages: any[], source: "backfill" | "live"): Promise<InsertResult> {
    if (rawMessages.length === 0) return { inserted: 0, skipped: 0, stored: [] };

    const db = await openDatabase();
    const now = Date.now();
    const seen = new Set<string>();
    const messages: StoredMessage[] = [];
    for (const raw of rawMessages) {
        const message = normalizeMessage(raw, source);
        if (!message.channelId || !message.id) continue;
        const key = `${message.channelId}:${message.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(message);
    }
    if (messages.length === 0) return { inserted: 0, skipped: 0, stored: [] };

    const tx = db.transaction(["messages", "authors", "conversations"], "readwrite");
    const messagesStore = tx.objectStore("messages");
    const authorsStore = tx.objectStore("authors");
    const conversationsStore = tx.objectStore("conversations");

    const existing = await Promise.all(
        messages.map(m => promisifyRequest<IDBValidKey | undefined>(messagesStore.getKey([m.channelId, m.id])))
    );

    const toInsert = messages.filter((_, i) => existing[i] == null);
    const inserted: InsertResult = { inserted: toInsert.length, skipped: messages.length - toInsert.length, stored: toInsert };
    if (toInsert.length === 0)
        return inserted;

    for (const message of toInsert)
        messagesStore.put(message);

    const touchedAuthors = new Map<string, StoredMessage>();
    const touchedChannels = new Map<string, StoredMessage[]>();
    for (const message of toInsert) {
        if (message.authorId && !touchedAuthors.has(message.authorId))
            touchedAuthors.set(message.authorId, message);
        const list = touchedChannels.get(message.channelId);
        if (list) list.push(message);
        else touchedChannels.set(message.channelId, [message]);
    }

    for (const [authorId, message] of touchedAuthors) {
        const existingAuthor = await promisifyRequest<StoredAuthor | undefined>(authorsStore.get(authorId));
        const globalName = message.authorName !== message.authorUsername ? message.authorName : null;
        if (!existingAuthor) {
            authorsStore.put({
                id: authorId,
                username: message.authorUsername,
                globalName,
                nameHistory: [],
                firstSeenMs: message.timestampMs || now,
                lastSeenMs: message.timestampMs || now
            });
            continue;
        }
        const nameChanged = existingAuthor.username !== message.authorUsername
            || (existingAuthor.globalName ?? null) !== globalName;
        if (nameChanged)
            existingAuthor.nameHistory.push({
                name: existingAuthor.globalName ?? existingAuthor.username,
                username: existingAuthor.username,
                changedAtMs: existingAuthor.lastSeenMs
            });
        existingAuthor.username = message.authorUsername;
        existingAuthor.globalName = globalName;
        existingAuthor.lastSeenMs = Math.max(existingAuthor.lastSeenMs, message.timestampMs || now);
        authorsStore.put(existingAuthor);
    }

    for (const [channelId, channelMessages] of touchedChannels) {
        const conversation = await promisifyRequest<StoredConversation | undefined>(conversationsStore.get(channelId));
        let newest = channelMessages[0];
        for (const message of channelMessages) {
            if (message.timestampMs > newest.timestampMs
                || (message.timestampMs === newest.timestampMs && message.id > newest.id))
                newest = message;
        }
        if (!conversation) {
            conversationsStore.put({
                id: channelId,
                type: 0,
                name: channelId,
                guildId: null,
                guildName: null,
                isDM: false,
                recipients: [],
                backfillStatus: "pending",
                backfillBefore: null,
                backfillFailures: 0,
                lastErrorCode: null,
                lastMessageId: newest.id,
                lastMessageTimestampMs: newest.timestampMs,
                messageCount: channelMessages.length,
                txtCursorMs: 0,
                txtCursorId: null,
                txtNeedsRebuild: false,
                jsonDirty: true,
                contentVersion: 0,
                updatedAtMs: now
            });
            continue;
        }
        conversation.messageCount += channelMessages.length;
        conversation.contentVersion++;
        // Out-of-order inserts (history recovery writing older messages after the TXT
        // cursor advanced) require a full TXT rebuild on the next flush
        if (conversation.txtCursorMs > 0 && channelMessages.some(m =>
            m.timestampMs < conversation.txtCursorMs
            || (m.timestampMs === conversation.txtCursorMs
                && conversation.txtCursorId != null
                && m.id < conversation.txtCursorId)))
            conversation.txtNeedsRebuild = true;
        if (!conversation.lastMessageTimestampMs
            || newest.timestampMs > conversation.lastMessageTimestampMs
            || (newest.timestampMs === conversation.lastMessageTimestampMs && newest.id > (conversation.lastMessageId ?? ""))) {
            conversation.lastMessageId = newest.id;
            conversation.lastMessageTimestampMs = newest.timestampMs;
        }
        conversation.jsonDirty = true;
        conversation.updatedAtMs = now;
        conversationsStore.put(conversation);
    }

    await promisifyRequest(tx);
    return inserted;
}

export async function getMessage(channelId: string, messageId: string): Promise<StoredMessage | undefined> {
    const db = await openDatabase();
    return promisifyRequest<StoredMessage | undefined>(
        db.transaction("messages").objectStore("messages").get([channelId, messageId])
    );
}

/** Looks up a message when only its global id is known (e.g. MESSAGE_DELETE without channel). */
export async function getMessageById(messageId: string): Promise<StoredMessage | undefined> {
    const db = await openDatabase();
    const store = db.transaction("messages").objectStore("messages");
    const key = await promisifyRequest<IDBValidKey | undefined>(store.index("by_messageId").getKey(messageId));
    if (key == null) return undefined;
    return promisifyRequest<StoredMessage | undefined>(store.get(key));
}

export async function patchMessage(
    channelId: string,
    messageId: string,
    patch: (message: StoredMessage) => boolean
): Promise<boolean> {
    const db = await openDatabase();
    const tx = db.transaction(["messages", "conversations"], "readwrite");
    const store = tx.objectStore("messages");
    const message = await promisifyRequest<StoredMessage | undefined>(store.get([channelId, messageId]));
    if (!message)
        return false;
    if (patch(message)) {
        store.put(message);
        await markConversationContentChanged(tx, channelId);
    }
    await promisifyRequest(tx);
    return true;
}

// Must run inside an active readwrite transaction on the "conversations" store
async function markConversationContentChanged(tx: IDBTransaction, channelId: string): Promise<void> {
    const store = tx.objectStore("conversations");
    const conversation = await promisifyRequest<StoredConversation | undefined>(store.get(channelId));
    if (!conversation) return;
    conversation.jsonDirty = true;
    conversation.contentVersion++;
    store.put(conversation);
}

export async function markMessageDeleted(channelId: string | null, messageId: string): Promise<DeleteLookup> {
    const db = await openDatabase();
    const tx = db.transaction(["messages", "conversations"], "readwrite");
    const store = tx.objectStore("messages");
    let message: StoredMessage | undefined;
    if (channelId)
        message = await promisifyRequest<StoredMessage | undefined>(store.get([channelId, messageId]));
    if (!message) {
        const key = await promisifyRequest<IDBValidKey | undefined>(
            store.index("by_messageId").getKey(messageId)
        );
        if (key == null)
            return "not_found";
        message = await promisifyRequest<StoredMessage | undefined>(store.get(key));
    }
    if (!message)
        return "not_found";
    if (!message.deleted) {
        message.deleted = true;
        message.deletedAtMs = Date.now();
        store.put(message);
        await markConversationContentChanged(tx, message.channelId);
    }
    await promisifyRequest(tx);
    return "deleted";
}

export async function recordEdit(channelId: string, messageId: string, newContent: string, editedAtMs: number | null): Promise<boolean> {
    const db = await openDatabase();
    const tx = db.transaction(["messages", "versions", "conversations"], "readwrite");
    const messagesStore = tx.objectStore("messages");
    const versionsStore = tx.objectStore("versions");
    const message = await promisifyRequest<StoredMessage | undefined>(messagesStore.get([channelId, messageId]));
    if (!message)
        return false;
    if (message.content === newContent)
        return true;
    const rowsBefore = await promisifyRequest<number>(
        versionsStore.index("by_message").count(IDBKeyRange.only([channelId, messageId]))
    );
    if (rowsBefore === 0) {
        versionsStore.put({
            channelId,
            messageId,
            version: 1,
            content: message.content,
            editedAtMs: message.edited ? message.timestampMs : null,
            capturedAtMs: message.capturedAtMs
        });
    }
    versionsStore.put({
        channelId,
        messageId,
        version: rowsBefore + 1,
        content: newContent,
        editedAtMs,
        capturedAtMs: Date.now()
    });
    message.content = newContent;
    message.edited = true;
    message.editCount = rowsBefore === 0 ? 1 : rowsBefore;
    messagesStore.put(message);
    await markConversationContentChanged(tx, channelId);
    await promisifyRequest(tx);
    return true;
}

export async function getVersions(channelId: string, messageId: string): Promise<StoredMessageVersion[]> {
    const db = await openDatabase();
    const store = db.transaction("versions").objectStore("versions");
    return promisifyRequest<StoredMessageVersion[]>(
        store.index("by_message").getAll(IDBKeyRange.only([channelId, messageId]))
    );
}

export async function recordReactionEvent(
    channelId: string,
    messageId: string,
    emoji: { id?: string | null; name?: string; },
    action: StoredReactionEvent["action"],
    userId: string | null
): Promise<void> {
    const db = await openDatabase();
    await promisifyRequest(db.transaction("reactions", "readwrite").objectStore("reactions").add({
        channelId,
        messageId,
        emojiId: emoji.id ?? null,
        emojiName: String(emoji.name ?? ""),
        action,
        userId,
        atMs: Date.now()
    }));
}

export async function applyReactionState(
    channelId: string,
    messageId: string,
    emoji: { id?: string | null; name?: string; animated?: boolean; },
    action: "add" | "remove",
    userId: string | null,
    count: number | null
): Promise<boolean> {
    return patchMessage(channelId, messageId, message => {
        const emojiId = emoji.id ?? null;
        const name = String(emoji.name ?? "");
        const existing = message.reactions.find(r => (emojiId != null ? r.emojiId === emojiId : r.name === name));
        if (action === "add") {
            const nextCount = count ?? (existing ? existing.count + 1 : 1);
            if (existing) existing.count = nextCount;
            else message.reactions.push({ emojiId, name, animated: Boolean(emoji.animated), count: nextCount });
        } else if (existing) {
            const nextCount = count ?? Math.max(existing.count - 1, 0);
            if (nextCount <= 0)
                message.reactions = message.reactions.filter(r => r !== existing);
            else existing.count = nextCount;
        }
        return true;
    });
}

export async function clearReactions(channelId: string, messageId: string): Promise<boolean> {
    return patchMessage(channelId, messageId, message => {
        if (message.reactions.length === 0) return false;
        message.reactions = [];
        return true;
    });
}

export async function setAttachmentState(
    channelId: string,
    messageId: string,
    attachmentId: string,
    state: { localPath: string | null; downloadState: StoredAttachment["downloadState"]; }
): Promise<boolean> {
    return patchMessage(channelId, messageId, message => {
        const attachment = message.attachments.find(a => a.id === attachmentId);
        if (!attachment) return false;
        attachment.localPath = state.localPath;
        attachment.downloadState = state.downloadState;
        return true;
    });
}

export async function upsertConversation(descriptor: Partial<StoredConversation> & { id: string; }): Promise<void> {
    const db = await openDatabase();
    const store = db.transaction("conversations", "readwrite").objectStore("conversations");
    const existing = await promisifyRequest<StoredConversation | undefined>(store.get(descriptor.id));
    const now = Date.now();
    if (!existing) {
        store.put({
            type: 0,
            name: descriptor.id,
            guildId: null,
            guildName: null,
            isDM: false,
            recipients: [],
            backfillStatus: "pending",
            backfillBefore: null,
            backfillFailures: 0,
            lastErrorCode: null,
            lastMessageId: null,
            lastMessageTimestampMs: null,
            messageCount: 0,
            txtCursorMs: 0,
            txtCursorId: null,
            txtNeedsRebuild: false,
            jsonDirty: true,
            contentVersion: 0,
            updatedAtMs: now,
            ...descriptor
        } satisfies StoredConversation);
        await promisifyRequest(store.transaction);
        return;
    }
    const merged: StoredConversation = {
        ...existing,
        ...descriptor,
        id: existing.id,
        messageCount: existing.messageCount,
        lastMessageId: descriptor.lastMessageId ?? existing.lastMessageId,
        lastMessageTimestampMs: descriptor.lastMessageTimestampMs ?? existing.lastMessageTimestampMs,
        // Dirty flags are OR-merged: only the single-transaction clear helpers below
        // may turn them off, so a stale read-modify-write can't lose a concurrent mutation
        txtNeedsRebuild: existing.txtNeedsRebuild || Boolean(descriptor.txtNeedsRebuild),
        jsonDirty: existing.jsonDirty || Boolean(descriptor.jsonDirty),
        // Versions only ever grow; max() prevents a stale descriptor from rolling it back
        contentVersion: Math.max(existing.contentVersion, descriptor.contentVersion ?? 0),
        updatedAtMs: now
    };
    store.put(merged);
    await promisifyRequest(store.transaction);
}

export async function getConversation(id: string): Promise<StoredConversation | undefined> {
    const db = await openDatabase();
    return promisifyRequest<StoredConversation | undefined>(
        db.transaction("conversations").objectStore("conversations").get(id)
    );
}

// Single-transaction read-modify-write helpers: they never overwrite state set by
// concurrent inserts because read and write share one transaction, and the version
// check refuses to clear a flag that a concurrent mutation re-set.

export async function clearJsonDirty(channelId: string, expectedVersion: number): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction("conversations", "readwrite");
    const store = tx.objectStore("conversations");
    const conversation = await promisifyRequest<StoredConversation | undefined>(store.get(channelId));
    if (conversation?.jsonDirty && conversation.contentVersion === expectedVersion) {
        conversation.jsonDirty = false;
        store.put(conversation);
    }
    await promisifyRequest(tx);
}

export async function updateTxtCursor(channelId: string, ms: number, id: string | null, expectedVersion?: number): Promise<void> {
    const db = await openDatabase();
    const tx = db.transaction("conversations", "readwrite");
    const store = tx.objectStore("conversations");
    const conversation = await promisifyRequest<StoredConversation | undefined>(store.get(channelId));
    if (!conversation) return;
    conversation.txtCursorMs = ms;
    conversation.txtCursorId = id;
    // A rebuild's flag is only cleared when nothing mutated during the rebuild;
    // otherwise the next flush rebuilds again and covers the concurrent change
    if (expectedVersion != null && conversation.contentVersion === expectedVersion)
        conversation.txtNeedsRebuild = false;
    conversation.updatedAtMs = Date.now();
    store.put(conversation);
    await promisifyRequest(tx);
}

export async function getAllConversations(): Promise<StoredConversation[]> {
    const db = await openDatabase();
    return promisifyRequest<StoredConversation[]>(
        db.transaction("conversations").objectStore("conversations").getAll()
    );
}

export async function getAuthor(id: string): Promise<StoredAuthor | undefined> {
    const db = await openDatabase();
    return promisifyRequest<StoredAuthor | undefined>(
        db.transaction("authors").objectStore("authors").get(id)
    );
}

export async function getAllAuthors(): Promise<StoredAuthor[]> {
    const db = await openDatabase();
    return promisifyRequest<StoredAuthor[]>(
        db.transaction("authors").objectStore("authors").getAll()
    );
}

export async function countAllMessages(): Promise<number> {
    const db = await openDatabase();
    return promisifyRequest<number>(db.transaction("messages").objectStore("messages").count());
}

export async function countChannelMessages(channelId: string): Promise<number> {
    const db = await openDatabase();
    const store = db.transaction("messages").objectStore("messages");
    return promisifyRequest<number>(
        store.index("by_channel_time").count(IDBKeyRange.bound([channelId, 0], [channelId, Infinity]))
    );
}

export async function countAuthors(): Promise<number> {
    const db = await openDatabase();
    return promisifyRequest<number>(db.transaction("authors").objectStore("authors").count());
}

export async function iterateChannelMessages(
    channelId: string,
    onBatch: (batch: StoredMessage[]) => void | Promise<void>,
    batchSize = 500,
    startAfter?: { ms: number; id: string | null; }
): Promise<number> {
    const db = await openDatabase();
    let afterMs = startAfter?.ms ?? 0;
    let skipId: string | null = startAfter?.id ?? null;
    let total = 0;

    while (true) {
        const batch: StoredMessage[] = [];
        let lastMs = afterMs;
        let lastId = skipId;

        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("messages", "readonly");
            const index = tx.objectStore("messages").index("by_channel_time");
            const request = index.openCursor(IDBKeyRange.bound([channelId, afterMs], [channelId, Infinity]));
            request.onerror = () => reject(request.error ?? new Error("Cursor iteration failed"));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || batch.length >= batchSize) {
                    resolve();
                    return;
                }
                const cursorMs = (cursor.key as [string, number])[1];
                const cursorId = (cursor.primaryKey as [string, string])[1];
                if (skipId != null && cursorMs === afterMs && cursorId <= skipId) {
                    cursor.continue();
                    return;
                }
                batch.push(cursor.value);
                lastMs = cursorMs;
                lastId = cursorId;
                cursor.continue();
            };
        });

        if (batch.length === 0) break;
        await onBatch(batch);
        total += batch.length;
        afterMs = lastMs;
        skipId = lastId;
        if (batch.length < batchSize) break;
    }

    return total;
}

export async function iterateAuthorMessages(
    authorId: string,
    onBatch: (batch: StoredMessage[]) => void | Promise<void>,
    batchSize = 500
): Promise<number> {
    const db = await openDatabase();
    const keys = await promisifyRequest<IDBValidKey[]>(
        db.transaction("messages").objectStore("messages").index("by_author").getAllKeys(IDBKeyRange.only(authorId))
    );

    let total = 0;
    for (let offset = 0; offset < keys.length; offset += batchSize) {
        const chunk = keys.slice(offset, offset + batchSize);
        const tx = db.transaction("messages", "readonly");
        const store = tx.objectStore("messages");
        const batch = (await Promise.all(
            chunk.map(key => promisifyRequest<StoredMessage | undefined>(store.get(key)))
        )).filter((m): m is StoredMessage => m != null);
        if (batch.length === 0) continue;
        await onBatch(batch);
        total += batch.length;
    }

    return total;
}

export interface ConversationCountMismatch {
    channelId: string;
    stored: number;
    actual: number;
}

export async function repairConversationCounts(): Promise<ConversationCountMismatch[]> {
    const conversations = await getAllConversations();
    const mismatches: ConversationCountMismatch[] = [];
    const db = await openDatabase();

    for (const conversation of conversations) {
        const actual = await promisifyRequest<number>(
            db.transaction("messages")
                .objectStore("messages")
                .index("by_channel_time")
                .count(IDBKeyRange.bound([conversation.id, 0], [conversation.id, Infinity]))
        );
        if (actual !== conversation.messageCount) {
            mismatches.push({ channelId: conversation.id, stored: conversation.messageCount, actual });
            conversation.messageCount = actual;
            await promisifyRequest(db.transaction("conversations", "readwrite").objectStore("conversations").put(conversation));
        }
    }

    return mismatches;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
    const db = await openDatabase();
    await promisifyRequest(db.transaction("meta", "readwrite").objectStore("meta").put({ key, value }));
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
    const db = await openDatabase();
    const row = await promisifyRequest<{ key: string; value: T; } | undefined>(
        db.transaction("meta").objectStore("meta").get(key)
    );
    return row?.value;
}
