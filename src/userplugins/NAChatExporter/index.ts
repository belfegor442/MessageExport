/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

import { settings } from "./settings";
import { logger } from "./utils/logger";

export default definePlugin({
    name: "NAChatExporter",
    description: "Export Discord conversations message by message to JSON, HTML, CSV or TXT, preserving order and metadata",
    authors: [{ name: "NA Tools", id: 0n }],
    searchTerms: ["export", "chat", "messages", "download", "backup"],
    tags: ["Utility", "Chat"],

    settings,

    start() {
        logger.info("NA Chat Exporter started (phase 4 scaffold)");
    },

    stop() {
        logger.info("NA Chat Exporter stopped");
    }
});
