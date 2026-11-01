/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { saveFile } from "@utils/web";
import type { Message } from "@vencord/discord-types";
import { showToast } from "@webpack/common";

import { collectMessages, type CollectResult } from "../collector";
import { type Conversation, resolveConversation } from "../conversationResolver";
import { logger } from "../utils/logger";

type ExportStatus = "complete" | "truncated" | "partial";

interface ExportPayload {
    schema: "na-chat-export/1";
    generatedAt: string;
    conversation: Conversation;
    integrity: {
        status: ExportStatus;
        stopReason: CollectResult["stopReason"];
        pagesFetched: number;
        failedFetches: number;
        deduplicatedMessages: number;
        messageCount: number;
        newestId: string | null;
        oldestId: string | null;
        error: string | null;
    };
    messages: Message[];
}

function getStatus(result: CollectResult): ExportStatus {
    if (result.stopReason === "error")
        return "partial";
    if (result.stopReason === "max_messages")
        return "truncated";
    return "complete";
}

function sanitizeFilename(name: string) {
    return name.replace(/[^\w-]+/g, "_").slice(0, 60) || "conversation";
}

function timestamp() {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export async function exportConversationJson(): Promise<void> {
    try {
        const conversation = resolveConversation();
        showToast({ text: `Exporting "${conversation.name}"...` });

        const result = await collectMessages(conversation.id);
        const status = getStatus(result);

        const payload: ExportPayload = {
            schema: "na-chat-export/1",
            generatedAt: new Date().toISOString(),
            conversation,
            integrity: {
                status,
                stopReason: result.stopReason,
                pagesFetched: result.pages,
                failedFetches: result.failures,
                deduplicatedMessages: result.deduplicated,
                messageCount: result.messages.length,
                newestId: result.newestId ?? null,
                oldestId: result.oldestId ?? null,
                error: result.error ?? null
            },
            messages: result.messages
        };

        const json = JSON.stringify(payload, null, 2);
        const data = new TextEncoder().encode(json);
        const filename = `${sanitizeFilename(conversation.name)}-${timestamp()}.json`;

        if (IS_DISCORD_DESKTOP)
            DiscordNative.fileManager.saveWithDialog(data, filename);
        else
            saveFile(new File([data], filename, { type: "application/json" }));

        const count = result.messages.length;
        if (status === "complete")
            showToast({ text: `Exported ${count} message${count === 1 ? "" : "s"} from "${conversation.name}"`, variant: "success" });
        else if (status === "truncated")
            showToast({ text: `Exported the last ${count} messages from "${conversation.name}" (message cap reached)` });
        else
            showToast({ text: `Export INCOMPLETE: ${count} messages from "${conversation.name}", ${result.failures} failed request(s)`, variant: "critical" });
    } catch (e: any) {
        logger.error("Export failed", e);
        showToast({ text: `Export failed: ${e?.message ?? String(e)}`, variant: "critical" });
    }
}
