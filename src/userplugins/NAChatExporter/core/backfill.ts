/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import { RestAPI } from "@webpack/common";

import { settings } from "../settings";
import { logger } from "../utils/logger";
import {
    getAllConversations,
    getConversation,
    insertMessagesIfAbsent,
    type StoredConversation,
    upsertConversation } from "./db";
import { logEvent } from "./events";
import { emitStored } from "./hooks";

const PAGE_SIZE = 100;
const MAX_FETCH_ATTEMPTS = 3;

export type BackfillOutcome = "complete" | "truncated" | "resumable" | "error" | "skipped";

export interface BackfillResult {
    channelId: string;
    outcome: BackfillOutcome;
    pages: number;
    inserted: number;
    skipped: number;
    failures: number;
    error?: string;
}

type FetchResult = { page: any[]; } | { error: string; status?: number; };

async function fetchPage(channelId: string, before?: string): Promise<FetchResult> {
    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
        try {
            const res = await RestAPI.get({
                url: `/channels/${channelId}/messages`,
                query: before ? { limit: PAGE_SIZE, before } : { limit: PAGE_SIZE },
                retries: 2
            });
            return { page: res?.body ?? [] };
        } catch (e: any) {
            const status: number | undefined = e?.status;
            if (status !== 429) {
                return { error: `HTTP ${status ?? "unknown"}`, status };
            }

            const retryAfter = e?.body?.retry_after;
            const waitMs = typeof retryAfter === "number"
                ? retryAfter < 1000 ? retryAfter * 1000 : retryAfter
                : 1000;
            logger.warn(`Rate limited during backfill, waiting ${waitMs}ms (attempt ${attempt}/${MAX_FETCH_ATTEMPTS})`);
            await sleep(waitMs);
        }
    }

    return { error: "rate limit retries exhausted" };
}

async function persistPage(channelId: string, page: any[]): Promise<{ inserted: number; skipped: number; }> {
    const result = await insertMessagesIfAbsent(page, "backfill");
    for (const message of result.stored)
        emitStored(message);
    return result;
}

async function persistCursor(channelId: string, before: string | null, status: StoredConversation["backfillStatus"], failures: number): Promise<void> {
    const conversation = await getConversation(channelId);
    if (!conversation) return;
    conversation.backfillBefore = before;
    conversation.backfillStatus = status;
    conversation.backfillFailures = failures;
    conversation.updatedAtMs = Date.now();
    await upsertConversation(conversation);
}

/**
 * Recovers accessible history for one conversation, newest → oldest, in pages.
 * Persists its cursor after every page so an interrupted run resumes instead of restarting.
 */
export async function backfillConversation(channelId: string, canAbort: () => boolean): Promise<BackfillResult> {
    const { pageDelayMs, maxMessages, backfillHistory } = settings.store;
    const base: BackfillResult = { channelId, outcome: "skipped", pages: 0, inserted: 0, skipped: 0, failures: 0 };

    if (!backfillHistory) return base;

    const conversation = await getConversation(channelId);
    if (!conversation) {
        base.error = "unknown conversation";
        return base;
    }
    if (conversation.backfillStatus === "complete") {
        base.outcome = "complete";
        return base;
    }

    let before = conversation.backfillBefore ?? undefined;
    let pages = 0;
    let inserted = 0;
    let skipped = 0;
    let failures = conversation.backfillFailures;
    let outcome: BackfillOutcome = "complete";
    let error: string | undefined;

    while (true) {
        if (canAbort()) {
            outcome = "resumable";
            break;
        }

        const result = await fetchPage(channelId, before);
        if ("error" in result) {
            failures++;
            outcome = "error";
            error = result.error;
            if (result.status === 403 || result.status === 404) {
                outcome = "error";
                error = `inaccessible (${result.status})`;
            }
            break;
        }

        const { page } = result;
        pages++;
        if (page.length === 0) break;

        const persisted = await persistPage(channelId, page);
        inserted += persisted.inserted;
        skipped += persisted.skipped;

        const oldest = page[page.length - 1];
        if (!oldest?.id || oldest.id === before) {
            failures++;
            outcome = "error";
            error = "pagination cursor did not advance";
            break;
        }
        before = oldest.id;
        await persistCursor(channelId, before ?? null, "in_progress", failures);

        if (maxMessages > 0 && inserted >= maxMessages) {
            outcome = "truncated";
            break;
        }

        if (page.length < PAGE_SIZE) break;

        await sleep(pageDelayMs);
    }

    if (outcome === "complete")
        await persistCursor(channelId, before ?? null, "complete", failures);
    else if (outcome === "truncated")
        // The user-configured cap defines the accepted recovery scope for this channel
        await persistCursor(channelId, before ?? null, "complete", failures);
    else if (outcome === "error")
        await persistCursor(channelId, before ?? null, "error", failures);

    const result: BackfillResult = { channelId, outcome, pages, inserted, skipped, failures, error };
    logEvent(logRoot, "backfill_page", {
        channelId,
        outcome,
        pages,
        inserted,
        failures
    });
    return result;
}

let logRoot = "";

export function setBackfillLogRoot(root: string): void {
    logRoot = root;
}

/** Backfills conversations sequentially (gentle on rate limits), skipping completed ones. */
export async function backfillAll(shouldStop: () => boolean): Promise<BackfillResult[]> {
    const conversations = await getAllConversations();
    const results: BackfillResult[] = [];
    for (const conversation of conversations) {
        if (shouldStop()) break;
        if (conversation.backfillStatus === "complete") continue;
        const result = await backfillConversation(conversation.id, shouldStop);
        results.push(result);
        if (result.outcome === "error")
            logger.warn(`Backfill error for ${conversation.id}: ${result.error}`);
    }
    return results;
}
