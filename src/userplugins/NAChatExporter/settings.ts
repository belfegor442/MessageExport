/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { GuildSelection } from "./GuildSelection";

type LifecycleHooks = {
    onArchivingToggled?: (enabled: boolean) => void;
    onStorageRootChanged?: () => void;
    onGuildSelectionChanged?: () => void;
};

let hooks: LifecycleHooks = {};

export function registerLifecycleHooks(next: LifecycleHooks): void {
    hooks = next;
}

export const settings = definePluginSettings({
    selectedGuildIds: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        hidden: true
    },
    guildSelectionComponent: {
        type: OptionType.COMPONENT,
        component: GuildSelection
    },
    archivingEnabled: {
        type: OptionType.BOOLEAN,
        description: "Opt in to automatically archive accessible conversations locally. Archives may contain sensitive messages; review the destination and retention before enabling.",
        default: false,
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
        description: "Opt in to download attachments from Discord's CDN. References are kept when downloads are disabled.",
        default: false
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
