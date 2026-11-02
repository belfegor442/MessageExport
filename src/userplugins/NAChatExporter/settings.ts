/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

type LifecycleHooks = {
    onArchivingToggled?: (enabled: boolean) => void;
    onStorageRootChanged?: () => void;
};

let hooks: LifecycleHooks = {};

export function registerLifecycleHooks(next: LifecycleHooks): void {
    hooks = next;
}

export const settings = definePluginSettings({
    archivingEnabled: {
        type: OptionType.BOOLEAN,
        description: "Automatically archive every accessible conversation (messages, edits, deletions, reactions) to disk",
        default: true,
        onChange: value => hooks.onArchivingToggled?.(Boolean(value))
    },
    storageRoot: {
        type: OptionType.STRING,
        description: "Folder where the archive is written, e.g. D:/NA-CHAT-EXPORTER",
        default: "D:/NA-CHAT-EXPORTER",
        onChange: () => hooks.onStorageRootChanged?.()
    },
    backfillHistory: {
        type: OptionType.BOOLEAN,
        description: "Opt in to recover accessible message history through Discord's API. This can archive a large amount of private content.",
        default: false
    },
    downloadAttachments: {
        type: OptionType.BOOLEAN,
        description: "Download attachments from Discord's CDN into the archive (references are always kept)",
        default: true
    },
    maintainCsv: {
        type: OptionType.BOOLEAN,
        description: "Also maintain CSV exports (TXT and JSON are always maintained)",
        default: false
    },
    pageDelayMs: {
        type: OptionType.SLIDER,
        description: "Delay between history fetch requests. Higher values are gentler on Discord",
        markers: [100, 250, 500, 1000, 2000],
        default: 500,
        stickToMarkers: false
    },
    maxMessages: {
        type: OptionType.NUMBER,
        description: "History cap per conversation during recovery (0 = no limit)",
        default: 0,
        isValid: value =>
            typeof value === "number" && Number.isInteger(value) && value >= 0
                || "Must be a whole number >= 0"
    }
});
