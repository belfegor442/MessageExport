/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Native } from "../utils/nativeBridge";

const FLUSH_DELAY_MS = 1000;

interface SessionRecord {
    id: string;
    startedAt: string;
    endedAt: string | null;
    crashed: boolean;
    pluginVersion: string;
    userAgent: string;
    stats: {
        messagesCaptured: number;
        liveEvents: number;
        backfillPages: number;
        attachmentsDownloaded: number;
        attachmentsFailed: number;
    };
}

interface IntegrityReport {
    verifiedAt: string;
    sessionId: string | null;
    totals: {
        messages: number;
        conversations: number;
        authors: number;
        incompleteBackfills: number;
    };
    countMismatches: { channelId: string; stored: number; actual: number; }[];
    derived: { path: string; bytes: number; mtimeMs: number; }[];
}

let currentSessionId: string | null = null;
let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function newSessionId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readJson<T>(root: string, relPath: string, fallback: T): Promise<T> {
    const text = await Native.read(root, relPath);
    if (text == null) return fallback;
    try {
        return JSON.parse(text) as T;
    } catch {
        return fallback;
    }
}

async function flushNow(root: string): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (pendingLines.length === 0) return;
    const chunk = pendingLines.join("") + "\n";
    pendingLines = [];
    try {
        await Native.append(root, "System/Events.jsonl", chunk);
    } catch (e) {
        // Never lose events silently: requeue so the next flush retries
        pendingLines.unshift(...(chunk.split("\n").filter(Boolean).map(l => `${l}\n`)));
        throw e;
    }
}

function scheduleFlush(root: string): void {
    if (flushTimer != null) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushNow(root).catch(() => { /* retried on next flush */ });
    }, FLUSH_DELAY_MS);
}

export function logEvent(root: string, type: string, data: Record<string, unknown>): void {
    if (!currentSessionId) return;
    pendingLines.push(JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: currentSessionId,
        type,
        ...data
    }));
    scheduleFlush(root);
}

export async function startSession(
    root: string,
    info: { pluginVersion: string; userAgent: string; }
): Promise<string> {
    await Native.ensureLayout(root, ["System", "Users", "Conversations/Direct-Messages", "Conversations/Group-Chats", "Conversations/Servers", "Attachments/Images", "Attachments/Videos", "Attachments/Audio", "Attachments/Documents", "Attachments/Stickers", "Attachments/Other", "Voice-Transcripts"]);

    const descriptor = {
        engine: "indexeddb",
        database: "NAChatExporterArchive",
        schemaVersion: 1,
        note: "Logical equivalent of System/archive.db: the primary store of truth is the renderer IndexedDB database named above. TXT/JSON/CSV files are derived exports.",
        updatedAt: new Date().toISOString()
    };
    await Native.writeAtomic(root, "System/archive.db", JSON.stringify(descriptor, null, 2));

    const file = await readJson<{ sessions: SessionRecord[]; }>(root, "System/Recording-Sessions.json", { sessions: [] });
    const last = file.sessions[file.sessions.length - 1];
    if (last && !last.endedAt) {
        last.endedAt = new Date().toISOString();
        last.crashed = true;
    }

    const session: SessionRecord = {
        id: newSessionId(),
        startedAt: new Date().toISOString(),
        endedAt: null,
        crashed: false,
        pluginVersion: info.pluginVersion,
        userAgent: info.userAgent,
        stats: {
            messagesCaptured: 0,
            liveEvents: 0,
            backfillPages: 0,
            attachmentsDownloaded: 0,
            attachmentsFailed: 0
        }
    };
    file.sessions.push(session);
    await Native.writeAtomic(root, "System/Recording-Sessions.json", JSON.stringify(file, null, 2));

    currentSessionId = session.id;
    return session.id;
}

export function getCurrentSessionId(): string | null {
    return currentSessionId;
}

export async function updateSessionStats(
    root: string,
    patch: Partial<SessionRecord["stats"]>
): Promise<void> {
    if (!currentSessionId) return;
    try {
        const file = await readJson<{ sessions: SessionRecord[]; }>(root, "System/Recording-Sessions.json", { sessions: [] });
        const session = file.sessions.find(s => s.id === currentSessionId);
        if (!session) return;
        for (const [key, value] of Object.entries(patch)) {
            if (typeof value === "number" && key in session.stats)
                session.stats[key as keyof SessionRecord["stats"]] = value;
        }
        await Native.writeAtomic(root, "System/Recording-Sessions.json", JSON.stringify(file, null, 2));
    } catch {
        // stats are best-effort; session end will still record the final state
    }
}

export async function endSession(root: string): Promise<void> {
    if (!currentSessionId) return;
    try {
        await flushNow(root);
    } catch {
        // flush retried by logEvent paths; session end must continue
    }

    try {
        const file = await readJson<{ sessions: SessionRecord[]; }>(root, "System/Recording-Sessions.json", { sessions: [] });
        const session = file.sessions.find(s => s.id === currentSessionId);
        if (session && !session.endedAt) {
            session.endedAt = new Date().toISOString();
            session.crashed = false;
            await Native.writeAtomic(root, "System/Recording-Sessions.json", JSON.stringify(file, null, 2));
        }
    } finally {
        currentSessionId = null;
    }
}

export async function writeIntegrity(
    root: string,
    report: Omit<IntegrityReport, "verifiedAt" | "sessionId" | "derived">,
    derivedPaths: string[] = []
): Promise<void> {
    const derived: IntegrityReport["derived"] = [];
    for (const path of derivedPaths) {
        try {
            const info = await Native.stat(root, path);
            if (info) derived.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
        } catch {
            // missing derived file is reported by its absence
        }
    }
    const payload: IntegrityReport = {
        verifiedAt: new Date().toISOString(),
        sessionId: currentSessionId,
        ...report,
        derived
    };
    await Native.writeAtomic(root, "System/Integrity.json", JSON.stringify(payload, null, 2));
}
