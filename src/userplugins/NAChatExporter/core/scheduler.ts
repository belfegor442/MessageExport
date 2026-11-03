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
    scanPendingAttachments,
} from "../attachments/download";
import {
    appendMarkerToTxt,
    appendMessagesToTxt,
    buildDeletionMarkerLines,
    buildEditMarkerLines,
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
    countChannelMessages,
    getAllConversations,
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

const PLUGIN_VERSION = "1.0.0";
const TXT_DEBOUNCE_MS = 100;
const JSON_DEBOUNCE_MS = 750;
const STATS_FLUSH_MS = 30000;
const BACKFILL_RESCAN_MS = 60000;
const MAX_BACKFILL_RETRY_MS = 15 * 60 * 1000;
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
let discoverTimer: ReturnType<typeof setTimeout> | null = null;
let rootChangeTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<void> = Promise.resolve();

const txtDirty = new Set<string>();
const jsonDirty = new Set<string>();
const pendingMarkers = new Map<string, string[][]>();
const jsonSnapshotChannels = new Set<string>();
const txtSnapshotChannels = new Set<string>();
const liveTxtDirty = new Set<string>();
const liveJsonDirty = new Set<string>();

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
    const dir = await resolveConversationDir(root, conversation);
    const path = `${dir}/Chat.txt`;
    const fileInfo = await Native.stat(root, path).catch(() => null);
    const fileExists = fileInfo != null;

    // Backfill arrives newest-to-oldest. Write one initial snapshot, then defer
    // historical pages while allowing live events to update the visible log.
    if (hasBackfillInFlight(conversation)) {
        if ((!fileInfo || fileInfo.size === 0)
            && !txtSnapshotChannels.has(channelId)
            && await countChannelMessages(channelId) > 0) {
            txtSnapshotChannels.add(channelId);
            liveTxtDirty.delete(channelId);
            pendingMarkers.delete(channelId);
            const version = conversation.contentVersion;
            const last = await rebuildConversationTxt(root, dir, conversation);
            await updateTxtCursor(
                channelId,
                last?.timestampMs ?? 0,
                last?.id ?? null,
                version
            );
            return;
        }
        if (!liveTxtDirty.has(channelId) && !pendingMarkers.has(channelId))
            return;
        liveTxtDirty.delete(channelId);
    }

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
    const dir = await resolveConversationDir(root, conversation);
    const path = `${dir}/Chat.json`;

    // Avoid a full JSON rewrite for every historical page, but persist the initial
    // snapshot and subsequent live updates.
    if (hasBackfillInFlight(conversation)) {
        const fileInfo = await Native.stat(root, path).catch(() => null);
        const needsSnapshot = (!fileInfo || fileInfo.size === 0)
            && !jsonSnapshotChannels.has(channelId)
            && await countChannelMessages(channelId) > 0;
        if (needsSnapshot || liveJsonDirty.has(channelId)) {
            jsonSnapshotChannels.add(channelId);
            liveJsonDirty.delete(channelId);
            const version = conversation.contentVersion;
            await rebuildConversationJson(root, dir, conversation);
            if (settings.store.maintainCsv)
                await rebuildConversationCsv(root, dir, conversation);
            await clearJsonDirty(channelId, version);
        }
        return;
    }

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

    if (settings.store.downloadSelectedAttachments) {
        for (const attachment of message.attachments) {
            if (attachment.downloadState === "pending")
                enqueueAttachment(root, message, attachment);
        }
    }

    if (message.source === "live") {
        liveTxtDirty.add(message.channelId);
        liveJsonDirty.add(message.channelId);
        scheduleTxtFlush(TXT_DEBOUNCE_MS);
        scheduleJsonFlush(JSON_DEBOUNCE_MS);
    } else {
        if (!txtSnapshotChannels.has(message.channelId))
            scheduleTxtFlush(0);
        if (!jsonSnapshotChannels.has(message.channelId))
            scheduleJsonFlush(0);
    }
}

function onMessageChanged(channelId: string): void {
    txtDirty.add(channelId);
    jsonDirty.add(channelId);
    liveTxtDirty.add(channelId);
    liveJsonDirty.add(channelId);
    scheduleTxtFlush(TXT_DEBOUNCE_MS);
    scheduleJsonFlush(JSON_DEBOUNCE_MS);
}

async function onMessageEdited(channelId: string, messageId: string): Promise<void> {
    statLiveEvents++;
    jsonDirty.add(channelId);
    liveJsonDirty.add(channelId);
    scheduleJsonFlush(JSON_DEBOUNCE_MS);
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
    liveJsonDirty.add(channelId);
    scheduleJsonFlush(JSON_DEBOUNCE_MS);
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
    const conversations = await getAllConversations();
    for (const conversation of conversations) {
        txtDirty.add(conversation.id);
        jsonDirty.add(conversation.id);
        jsonSnapshotChannels.delete(conversation.id);
        txtSnapshotChannels.delete(conversation.id);
    }

    await scanPendingAttachments(root);

    scheduleTxtFlush(0);
    scheduleJsonFlush(0);
}

async function runBackfillLoop(): Promise<void> {
    const retryAt = new Map<string, number>();
    while (!stopRequested && settings.store.backfillHistory) {
        try {
            const conversations = await getAllConversations();
            for (const conversation of conversations) {
                if (stopRequested || !settings.store.backfillHistory) break;
                if (conversation.backfillStatus === "complete") continue;
                if (Date.now() < (retryAt.get(conversation.id) ?? 0)) continue;

                const result = await backfillConversation(
                    conversation.id,
                    () => stopRequested || !settings.store.backfillHistory
                );
                statBackfillPages += result.pages;
                logEvent(root, "backfill_result", {
                    channelId: result.channelId,
                    outcome: result.outcome,
                    pages: result.pages,
                    inserted: result.inserted,
                    failures: result.failures,
                    error: result.error ?? null
                });
                if (result.outcome === "error") {
                    logger.warn(`History recovery failed for ${result.channelId}: ${result.error}`);
                    const exponent = Math.min(Math.max(result.failures - 1, 0), 4);
                    const retryInMs = Math.min(60000 * (2 ** exponent), MAX_BACKFILL_RETRY_MS);
                    retryAt.set(result.channelId, Date.now() + retryInMs);
                    logEvent(root, "backfill_retry_scheduled", {
                        channelId: result.channelId,
                        retryInMs,
                        failures: result.failures
                    });
                } else {
                    retryAt.delete(result.channelId);
                }

                // Recovery settled for this channel: unblock its derived files
                txtDirty.add(conversation.id);
                jsonDirty.add(conversation.id);
                scheduleTxtFlush(0);
                scheduleJsonFlush(0);
            }
        } catch (e) {
            logger.error("History recovery pass failed", e);
            logEvent(root, "backfill_pass_error", { error: e instanceof Error ? e.message : String(e) });
        }

        let remainingMs = BACKFILL_RESCAN_MS;
        while (remainingMs > 0 && !stopRequested && settings.store.backfillHistory) {
            const intervalMs = Math.min(remainingMs, 1000);
            await sleep(intervalMs);
            remainingMs -= intervalMs;
        }
    }
}

function launchBackfillLoop(): void {
    if (!running || stopRequested || !settings.store.backfillHistory || backfillLoop)
        return;

    const loop = runBackfillLoop();
    backfillLoop = loop;
    void loop.then(() => {
        if (backfillLoop === loop)
            backfillLoop = null;
        if (running && !stopRequested && settings.store.backfillHistory)
            launchBackfillLoop();
    }, e => {
        if (backfillLoop === loop)
            backfillLoop = null;
        logger.error("History recovery loop failed", e);
    });
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
        const conversations = await getAllConversations();
        for (const conversation of conversations) {
            txtDirty.add(conversation.id);
            if (conversation.jsonDirty) jsonDirty.add(conversation.id);
        }
        await enqueueFlush(async () => {
            await drainTxt();
            await drainJson();
        });
    } catch (e) {
        logger.error("Final derived flush failed", e);
    }

    try {
        const conversations = await getAllConversations();
        const mismatches = await repairConversationCounts();
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

        registerDerivedHooks({ onMessageStored, onMessageChanged, onMessageEdited, onMessageDeleted });
        setArchivingActive(true);

        await discoverConversations(root);
        await seedPendingWork();

        launchBackfillLoop();
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

export function handleBackfillHistoryChanged(enabled: boolean): void {
    if (enabled)
        launchBackfillLoop();
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

export function handleAttachmentGuildsChanged(): void {
    clearDownloadQueue();
    if (running && settings.store.downloadSelectedAttachments)
        void scanPendingAttachments(root).catch(e => logger.error("Attachment rescan failed", e));
}

export function requestDiscover(): void {
    if (!running || stopRequested || discoverTimer) return;
    discoverTimer = setTimeout(() => {
        discoverTimer = null;
        if (!running) return;
        discoverConversations(root).catch(e => logger.error("Conversation discovery failed", e));
    }, DISCOVER_DEBOUNCE_MS);
}
