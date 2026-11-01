/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sleep } from "@utils/misc";
import type { Message } from "@vencord/discord-types";
import { RestAPI } from "@webpack/common";

import { settings } from "./settings";
import { logger } from "./utils/logger";

const PAGE_SIZE = 100;
const MAX_FETCH_ATTEMPTS = 3;

export type StopReason = "reached_beginning" | "max_messages" | "error";

export interface CollectResult {
    /** Oldest to newest */
    messages: Message[];
    stopReason: StopReason;
    pages: number;
    /** Pages that could not be fetched after retries */
    failures: number;
    deduplicated: number;
    newestId?: string;
    oldestId?: string;
    error?: string;
}

type FetchResult = { page: Message[]; } | { error: string; };

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
            if (e?.status !== 429) {
                logger.error(`Fetching messages failed with HTTP ${e?.status ?? "unknown"}`, e);
                return { error: `HTTP ${e?.status ?? "unknown"}` };
            }

            // retry_after may be seconds or ms depending on the endpoint; small values are seconds
            const retryAfter = e?.body?.retry_after;
            const waitMs = typeof retryAfter === "number"
                ? retryAfter < 1000 ? retryAfter * 1000 : retryAfter
                : 1000;
            logger.warn(`Rate limited, waiting ${waitMs}ms (attempt ${attempt}/${MAX_FETCH_ATTEMPTS})`);
            await sleep(waitMs);
        }
    }

    return { error: "rate limit retries exhausted" };
}

export async function collectMessages(channelId: string): Promise<CollectResult> {
    const { pageDelayMs, maxMessages } = settings.store;

    const messages: Message[] = [];
    const seen = new Set<string>();
    let before: string | undefined;
    let pages = 0;
    let failures = 0;
    let deduplicated = 0;
    let stopReason: StopReason = "reached_beginning";
    let error: string | undefined;

    while (true) {
        const result = await fetchPage(channelId, before);
        if ("error" in result) {
            failures++;
            stopReason = "error";
            error = result.error;
            break;
        }

        pages++;
        const { page } = result;
        if (page.length === 0)
            break;

        for (const message of page) {
            if (seen.has(message.id)) {
                deduplicated++;
                continue;
            }
            seen.add(message.id);

            if (maxMessages > 0 && messages.length >= maxMessages)
                break;
            messages.push(message);
        }

        if (maxMessages > 0 && messages.length >= maxMessages) {
            stopReason = "max_messages";
            break;
        }

        if (page.length < PAGE_SIZE)
            break;

        const nextBefore = page[page.length - 1].id;
        if (!nextBefore || nextBefore === before) {
            failures++;
            stopReason = "error";
            error = "pagination cursor did not advance";
            break;
        }
        before = nextBefore;

        await sleep(pageDelayMs);
    }

    messages.reverse();

    return {
        messages,
        stopReason,
        pages,
        failures,
        deduplicated,
        newestId: messages[messages.length - 1]?.id,
        oldestId: messages[0]?.id
    };
}
