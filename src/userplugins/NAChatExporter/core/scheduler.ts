/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";

import {
    awaitIdleDownloads,
    clearDownloadQueue,
    enqueueAttachment,
    getAttachmentStats,
    resetAttachmentStats,
} from "../attachments/download";
import {
    appendMarkerToTxt,
    appendMessagesToTxt,
    buildDeletionMarkerLines,
    buildEditMarkerLines,
    rebuildAuthorFiles,
    rebuildConversationCsv,
    rebuildConversationJson,
    rebuildConversationTxt,
    resolveConversationDir,
} from "../derived/writer";
import { settings } from "../settings";
import { logger } from "../utils/logger";
import { Native } from "../utils/nativeBridge";
import { backfillConversation, setBackfillLogRoot } from "./backfill";
import {
    clearJsonDirty,
    closeDatabase,
    countAllMessages,
    countAuthors,
    getAllAuthors,
    getAllConversations,
    getAuthor,
    getConversation,
    getMessage,
    iterateChannelMessages,
    openDatabase,
    repairConversationCounts,
    type StoredConversation,
    type StoredMessage,
    updateTxtCursor,
} from "./db";
import { endSession, logEvent, startSession, updateSessionStats, writeIntegrity } from "./events";
import { registerDerivedHooks, setArchivingActive } from "./hooks";
import { setLiveLogRoot } from "./live";
import { discoverConversations } from "./registry";
import { isChannelInArchiveScope } from "./scope";

const PLUGIN_VERSION = "1.0.0";
const TXT_DEBOUNCE_MS = 2000;
const JSON_DEBOUNCE_MS = 15000;
const AUTHOR_DEBOUNCE_MS = 600000;
const STATS_FLUSH_MS = 30000;
const BACKFILL_RESCAN_MS = 60000;
const DISCOVER_DEBOUNCE_MS = 2000;
const ROOT_CHANGE_DEBOUNCE_MS = 1500;
const MAX_DRAIN_ROUNDS = 10;

let running = false;
let stopRequested = false;
let root = "";
let stopPromise: Promise<void> | null = null;
let backfillLoop: Promise<void> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let txtTimer: ReturnType<typeof setTimeout> | null = null;
let jsonTimer: ReturnType<typeof setTimeout> | null = null;
let authorTimer: ReturnType<typeof setTimeout> | null = null;
let discoverTimer: ReturnType<typeof setTimeout> | null = null;
let rootChangeTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();

const txtDirty = new Set<string>();
const jsonDirty = new Set<string>();
const authorDirty = new Set<string>();
const pendingMarkers = new Map<string, string[][]>();

let statMessages = 0;
let statLiveEvents = 0;
let statBackfillPages = 0;

function scheduleTxtFlush(delay = TXT_DEBOUNCE_MS): void {
    if (!running || stopRequested) return;
    if (txtTimer) clearTimeout(txtTimer);
    txtTimer = setTimeout(() => {
        txtTimer = null;
        void enqueueFlush(drainTxt);
    }, delay);
}

function scheduleJsonFlush(delay = JSON_DEBOUNCE_MS): void {
    if (!running || stopRequested) return;
    if (jsonTimer) clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => {
        jsonTimer = null;
        void enqueueFlush(drainJson);
    }, delay);
}

function scheduleAuthorFlush(delay = AUTHOR_DEBOUNCE_MS): void {
    if (!running || stopRequested) return;
    if (authorTimer) clearTimeout(authorTimer);
    authorTimer = setTimeout(() => {
        authorTimer = null;
        void enqueueFlush(drainAuthors);
    }, delay);
}

// Serializes every derived-file job: the TXT cursor and the JSON dirty flag both do
// read-modify-write on conversations, so flushes must never interleave.
function enqueueFlush(job: () => Promise<void>): Promise<void> {
    const run = async () => {
        try {
            await job();
        } catch (e) {
            logger.error("Derived file flush failed", e);
        }
    };
    flushChain = flushChain.then(run, run);
    return flushChain;
}

function hasBackfillInFlight(conversation: StoredConversation): boolean {
    return settings.store.backfillHistory
        && (conversation.backfillStatus === "pending" || conversation.backfillStatus === "in_progress");
}

async function flushTxt(channelId: string): Promise<void> {
    const conversation = await getConversation(channelId);
    if (!conversation) {
        pendingMarkers.delete(channelId);
        return;
    }
    // Hold the TXT file until history recovery settles: backfill inserts older
    // messages, and an append-only file written mid-recovery would look complete
    // while silently missing the oldest history. The txtNeedsRebuild flag in the
    // database survives this deferral.
    if (hasBackfillInFlight(conversation)) {
        txtDirty.add(channelId);
        return;
    }

    const dir = await resolveConversationDir(root, conversation);
    const path = `${dir}/Chat.txt`;

    const fileExists = (await Native.stat(root, path).catch(() => null)) != null;
    const needsRebuild = conversation.txtNeedsRebuild || fileExists !== (conversation.txtCursorMs > 0);

    if (needsRebuild) {
        const version = conversation.contentVersion;
        const last = await rebuildConversationTxt(root, dir, conversation);
        // A rebuild renders current state, so queued markers for this channel would duplicate
        pendingMarkers.delete(channelId);
        await updateTxtCursor(
            channelId,
            last?.timestampMs ?? conversation.txtCursorMs,
            last?.id ?? conversation.txtCursorId,
            version
        );
        return;
    }

    const markers = pendingMarkers.get(channelId);
    if (markers) {
        pendingMarkers.delete(channelId);
        for (const block of markers) {
            try {
                await appendMarkerToTxt(root, path, block);
            } catch (e) {
                const requeue = pendingMarkers.get(channelId) ?? [];
                pendingMarkers.set(channelId, [block, ...requeue]);
                throw e;
            }
        }
    }

    const appended: StoredMessage[] = [];
    await iterateChannelMessages(channelId, batch => {
        appended.push(...batch);
        return appendMessagesToTxt(root, path, batch);
    }, 500, { ms: conversation.txtCursorMs, id: conversation.txtCursorId });

    const last = appended[appended.length - 1];
    if (last)
        await updateTxtCursor(channelId, last.timestampMs, last.id);
}

async function drainTxt(): Promise<void> {
    for (let round = 0; round < MAX_DRAIN_ROUNDS && (txtDirty.size > 0 || pendingMarkers.size > 0); round++) {
        const ids = new Set([...txtDirty, ...pendingMarkers.keys()]);
        txtDirty.clear();
        for (const id of ids) {
            try {
                await flushTxt(id);
            } catch (e) {
                logger.error(`TXT flush failed for ${id}`, e);
                txtDirty.add(id);
            }
        }
    }
    if (txtDirty.size > 0 || pendingMarkers.size > 0)
        logger.warn("TXT flush rounds exhausted with work pending; will retry on the next trigger");
}

async function flushJson(channelId: string): Promise<void> {
    const conversation = await getConversation(channelId);
    if (!conversation) return;
    // Perf deferral only: JSON is a full dump of the source of truth, but rebuilding
    // a large channel on every page of its history recovery would be wasteful
    if (hasBackfillInFlight(conversation)) {
        jsonDirty.add(channelId);
        return;
    }

    const dir = await resolveConversationDir(root, conversation);
    const version = conversation.contentVersion;
    await rebuildConversationJson(root, dir, conversation);
    if (settings.store.maintainCsv)
        await rebuildConversationCsv(root, dir, conversation);
    // Cleared only if nothing mutated during the rebuild; a concurrent insert keeps
    // the flag set and the next flush rebuilds again
    await clearJsonDirty(channelId, version);
}

async function drainJson(): Promise<void> {
    for (let round = 0; round < MAX_DRAIN_ROUNDS && jsonDirty.size > 0; round++) {
        const ids = [...jsonDirty];
        jsonDirty.clear();
        for (const id of ids) {
            try {
                await flushJson(id);
            } catch (e) {
                logger.error(`JSON flush failed for ${id}`, e);
                jsonDirty.add(id);
            }
        }
    }
}

async function drainAuthors(): Promise<void> {
    for (let round = 0; round < MAX_DRAIN_ROUNDS && authorDirty.size > 0; round++) {
        const ids = [...authorDirty];
        authorDirty.clear();
        for (const id of ids) {
            try {
                const author = await getAuthor(id);
                if (author)
                    await rebuildAuthorFiles(root, author);
            } catch (e) {
                logger.error(`Author files flush failed for ${id}`, e);
                authorDirty.add(id);
            }
        }
    }
}

// Mirrors the cursor comparison used by the append path: a message at or below the
// cursor has already been written to Chat.txt
function wasWritten(conversation: StoredConversation, message: StoredMessage): boolean {
    if (message.timestampMs < conversation.txtCursorMs) return true;
    if (message.timestampMs > conversation.txtCursorMs) return false;
    const cursorId = conversation.txtCursorId;
    if (cursorId == null) return false;
    return message.id.length !== cursorId.length
        ? message.id.length < cursorId.length
        : message.id <= cursorId;
}

function queueMarker(channelId: string, block: string[]): void {
    const queue = pendingMarkers.get(channelId) ?? [];
    queue.push(block);
    pendingMarkers.set(channelId, queue);
    txtDirty.add(channelId);
    scheduleTxtFlush();
}

function onMessageStored(message: StoredMessage): void {
    statMessages++;
    if (message.source === "live") statLiveEvents++;

    txtDirty.add(message.channelId);
    jsonDirty.add(message.channelId);
    if (message.authorId) authorDirty.add(message.authorId);

    if (settings.store.downloadAttachments) {
        for (const attachment of message.attachments) {
            if (attachment.downloadState === "pending")
                enqueueAttachment(root, message, attachment);
        }
    }

    scheduleTxtFlush();
    // Backfill pages only dirty the sets; their rebuilds are scheduled when the
    // recovery loop settles, avoiding repeated full rewrites of a growing channel
    if (message.source === "live") {
        scheduleJsonFlush();
        scheduleAuthorFlush();
    }
}

async function onMessageEdited(channelId: string, messageId: string): Promise<void> {
    statLiveEvents++;
    jsonDirty.add(channelId);
    scheduleJsonFlush();
    try {
        const message = await getMessage(channelId, messageId);
        if (!message) return;
        const conversation = await getConversation(channelId);
        if (!conversation || !wasWritten(conversation, message)) return;
        queueMarker(channelId, await buildEditMarkerLines(message));
    } catch (e) {
        logger.error("Failed to queue edit marker", e);
    }
}

async function onMessageDeleted(channelId: string, messageId: string): Promise<void> {
    statLiveEvents++;
    jsonDirty.add(channelId);
    scheduleJsonFlush();
    try {
        const message = await getMessage(channelId, messageId);
        if (!message) return;
        const conversation = await getConversation(channelId);
        if (!conversation || !wasWritten(conversation, message)) return;
        queueMarker(channelId, buildDeletionMarkerLines(message));
    } catch (e) {
        logger.error("Failed to queue deletion marker", e);
    }
}

async function seedPendingWork(): Promise<void> {
    const allConversations = await getAllConversations();
    const conversations = [];
    for (const conversation of allConversations) {
        if (await isChannelInArchiveScope(conversation.id))
            conversations.push(conversation);
    }
    for (const conversation of conversations) {
        txtDirty.add(conversation.id);
        if (conversation.jsonDirty) jsonDirty.add(conversation.id);
    }
    const authors = await getAllAuthors();
    for (const author of authors)
        authorDirty.add(author.id);

    if (settings.store.downloadAttachments) {
        for (const conversation of conversations) {
            await iterateChannelMessages(conversation.id, batch => {
                for (const message of batch) {
                    for (const attachment of message.attachments) {
                        if (attachment.downloadState === "pending")
                            enqueueAttachment(root, message, attachment);
                    }
                }
            }, 200);
        }
    }

    scheduleTxtFlush(0);
    scheduleJsonFlush(0);
    scheduleAuthorFlush(0);
}

async function runBackfillLoop(): Promise<void> {
    const attempted = new Set<string>();
    while (!stopRequested) {
        try {
            const allConversations = await getAllConversations();
            for (const conversation of allConversations) {
                if (stopRequested) break;
                if (!await isChannelInArchiveScope(conversation.id)) continue;
                if (attempted.has(conversation.id)) continue;
                attempted.add(conversation.id);
                if (conversation.backfillStatus === "complete") continue;

                const result = await backfillConversation(conversation.id, () => stopRequested);
                statBackfillPages += result.pages;
                logEvent(root, "backfill_result", {
                    channelId: result.channelId,
                    outcome: result.outcome,
                    pages: result.pages,
                    inserted: result.inserted,
                    failures: result.failures,
                    error: result.error ?? null
                });
                if (result.outcome === "error")
                    logger.warn(`History recovery failed for ${result.channelId}: ${result.error}`);

                // Recovery settled for this channel: unblock its derived files
                txtDirty.add(conversation.id);
                jsonDirty.add(conversation.id);
                scheduleTxtFlush(0);
                scheduleJsonFlush(0);
                scheduleAuthorFlush();
            }
        } catch (e) {
            logger.error("History recovery pass failed", e);
            logEvent(root, "backfill_pass_error", { error: e instanceof Error ? e.message : String(e) });
        }

        if (stopRequested) break;
        await sleep(BACKFILL_RESCAN_MS);
    }
}

async function flushSessionStats(): Promise<void> {
    if (!running || !root) return;
    const attachmentStats = getAttachmentStats();
    await updateSessionStats(root, {
        messagesCaptured: statMessages,
        liveEvents: statLiveEvents,
        backfillPages: statBackfillPages,
        attachmentsDownloaded: attachmentStats.downloaded,
        attachmentsFailed: attachmentStats.failed
    });
}

async function doStop(autoRestart: boolean): Promise<void> {
    stopRequested = true;
    // Disable hook side effects first; anything an in-flight handler still writes is
    // covered by the database flags that the final re-seed below reads
    setArchivingActive(false);

    if (discoverTimer) { clearTimeout(discoverTimer); discoverTimer = null; }
    if (txtTimer) { clearTimeout(txtTimer); txtTimer = null; }
    if (jsonTimer) { clearTimeout(jsonTimer); jsonTimer = null; }
    if (authorTimer) { clearTimeout(authorTimer); authorTimer = null; }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }

    // Drop queued (not started) downloads, then wait for the one in flight so it
    // can't write to the database after it closes
    clearDownloadQueue();
    await awaitIdleDownloads();

    if (backfillLoop) {
        await backfillLoop.catch(() => { });
        backfillLoop = null;
    }

    // Final drain: re-seed from the database so everything the source of truth has
    // is exported before the session closes
    try {
        const allConversations = await getAllConversations();
        const conversations = [];
        for (const conversation of allConversations) {
            if (await isChannelInArchiveScope(conversation.id))
                conversations.push(conversation);
        }
        for (const conversation of conversations) {
            txtDirty.add(conversation.id);
            if (conversation.jsonDirty) jsonDirty.add(conversation.id);
        }
        await enqueueFlush(async () => {
            await drainTxt();
            await drainJson();
            await drainAuthors();
        });
    } catch (e) {
        logger.error("Final derived flush failed", e);
    }

    try {
        const allConversations = await getAllConversations();
        const conversations = [];
        for (const conversation of allConversations) {
            if (await isChannelInArchiveScope(conversation.id))
                conversations.push(conversation);
        }
        const mismatches = (await repairConversationCounts()).filter(m => conversations.some(conversation => conversation.id === m.channelId));
        const incompleteBackfills = conversations.filter(c =>
            c.backfillStatus === "pending" || c.backfillStatus === "in_progress"
        ).length;
        const derivedPaths: string[] = [];
        for (const conversation of conversations) {
            try {
                const dir = await resolveConversationDir(root, conversation);
                derivedPaths.push(`${dir}/Chat.txt`, `${dir}/Chat.json`);
                if (settings.store.maintainCsv)
                    derivedPaths.push(`${dir}/Chat.csv`);
            } catch {
                // an unresolvable directory is reported by its absence below
            }
        }
        await writeIntegrity(root, {
            totals: {
                messages: await countAllMessages(),
                conversations: conversations.length,
                authors: await countAuthors(),
                incompleteBackfills
            },
            countMismatches: mismatches
        }, derivedPaths);
    } catch (e) {
        logger.error("Integrity report failed", e);
    }

    await flushSessionStats().catch(() => { });
    await endSession(root).catch(e => logger.error("Failed to close recording session", e));
    await closeDatabase().catch(() => { });

    running = false;
    root = "";
    logger.info("Archiving stopped");

    // A stop triggered by the storage-folder setting (or a rapid toggle) should
    // come back up with the current setting state
    if (autoRestart && settings.store.archivingEnabled)
        void startArchiving();
}

export function stopArchiving(autoRestart = true): Promise<void> {
    if (stopPromise) return stopPromise;
    if (!running) return Promise.resolve();
    stopPromise = doStop(autoRestart).finally(() => {
        stopPromise = null;
    });
    return stopPromise;
}

export async function startArchiving(): Promise<void> {
    if (stopPromise) await stopPromise;
    if (running) return;

    const nextRoot = settings.store.storageRoot.trim();
    if (!nextRoot) {
        logger.error("Storage folder setting is empty; archiving was not started");
        return;
    }
    root = nextRoot;
    running = true;
    stopRequested = false;
    statMessages = 0;
    statLiveEvents = 0;
    statBackfillPages = 0;
    resetAttachmentStats();

    try {
        await openDatabase();
        setLiveLogRoot(root);
        setBackfillLogRoot(root);
        await startSession(root, { pluginVersion: PLUGIN_VERSION, userAgent: navigator.userAgent });

        registerDerivedHooks({ onMessageStored, onMessageEdited, onMessageDeleted });
        setArchivingActive(true);

        await discoverConversations(root);
        await seedPendingWork();

        if (settings.store.backfillHistory)
            backfillLoop = runBackfillLoop();
        statsTimer = setInterval(() => { void flushSessionStats(); }, STATS_FLUSH_MS);

        logEvent(root, "archiving_started", { storageRoot: root });
        logger.info(`Archiving started → ${root}`);
    } catch (e) {
        running = false;
        setArchivingActive(false);
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        await closeDatabase().catch(() => { });
        logger.error("Failed to start archiving (is this Discord Desktop with native fs access?)", e);
    }
}

export function handleArchivingToggled(enabled: boolean): Promise<void> {
    return enabled ? startArchiving() : stopArchiving();
}

export function handleGuildSelectionChanged(): void {
    if (running)
        void stopArchiving(true);
}

export function handleStorageRootChanged(): void {
    if (!running) return;
    if (rootChangeTimer) clearTimeout(rootChangeTimer);
    rootChangeTimer = setTimeout(() => {
        rootChangeTimer = null;
        if (!running) return;
        const configured = settings.store.storageRoot.trim();
        if (!configured || configured === root) return;
        void stopArchiving(true); // auto-restart picks up the new folder
    }, ROOT_CHANGE_DEBOUNCE_MS);
}

export function requestDiscover(): void {
    if (!running || stopRequested || discoverTimer) return;
    discoverTimer = setTimeout(() => {
        discoverTimer = null;
        if (!running) return;
        discoverConversations(root).catch(e => logger.error("Conversation discovery failed", e));
    }, DISCOVER_DEBOUNCE_MS);
}
