/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

import {
    handleMessageCreate,
    handleMessageDelete,
    handleMessageDeleteBulk,
    handleMessageUpdate,
    handleReactionAdd,
    handleReactionRemove,
    handleReactionRemoveAll,
    handleVoiceStateUpdate,
} from "./core/live";
import {
    handleArchivingToggled,
    handleGuildSelectionChanged,
    handleStorageRootChanged,
    requestDiscover,
    startArchiving,
    stopArchiving,
} from "./core/scheduler";
import { registerLifecycleHooks, settings } from "./settings";
import { logger } from "./utils/logger";

export default definePlugin({
    name: "NAChatExporter",
    description: "Archives only servers explicitly selected by the user, plus direct messages, to a local folder with TXT/JSON/CSV exports",
    authors: [{ name: "NA Tools", id: 0n }],
    searchTerms: ["export", "chat", "messages", "download", "backup", "archive"],
    tags: ["Utility", "Chat"],

    settings,

    flux: {
        MESSAGE_CREATE: e => {
            if (!e.optimistic)
                void handleMessageCreate(e);
        },
        MESSAGE_UPDATE: e => void handleMessageUpdate(e),
        MESSAGE_DELETE: e => void handleMessageDelete(e),
        MESSAGE_DELETE_BULK: e => void handleMessageDeleteBulk(e),
        MESSAGE_REACTION_ADD: e => void handleReactionAdd(e),
        MESSAGE_REACTION_REMOVE: e => void handleReactionRemove(e),
        MESSAGE_REACTION_REMOVE_ALL: e => void handleReactionRemoveAll(e),
        MESSAGE_REACTION_REMOVE_EMOJI: e => void handleReactionRemove({ ...e, count: 0 }),
        VOICE_STATE_UPDATES: e => void handleVoiceStateUpdate(e),
        CHANNEL_CREATE: () => requestDiscover(),
        THREAD_CREATE: () => requestDiscover(),
        GUILD_CREATE: () => requestDiscover(),
    },

    start() {
        registerLifecycleHooks({
            onArchivingToggled: handleArchivingToggled,
            onStorageRootChanged: handleStorageRootChanged,
            onGuildSelectionChanged: handleGuildSelectionChanged
        });
        if (settings.store.archivingEnabled)
            void startArchiving();
        logger.info("NA Chat Exporter loaded");
    },

    stop() {
        registerLifecycleHooks({});
        void stopArchiving(false);
        logger.info("NA Chat Exporter unloaded");
    }
});
