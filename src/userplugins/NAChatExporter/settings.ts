/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { ExportButton } from "./components/ExportButton";

export const settings = definePluginSettings({
    exportJson: {
        type: OptionType.COMPONENT,
        component: ExportButton
    },
    defaultFormat: {
        type: OptionType.SELECT,
        description: "Default export format preselected in the export dialog",
        options: [
            { label: "JSON (structured, lossless)", value: "json", default: true },
            { label: "HTML (readable transcript)", value: "html" },
            { label: "CSV (spreadsheet table)", value: "csv" },
            { label: "TXT (plain text)", value: "txt" }
        ]
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
        description: "Safety cap for messages per export (0 = no limit)",
        default: 0,
        isValid: value =>
            typeof value === "number" && Number.isInteger(value) && value >= 0
                || "Must be a whole number >= 0"
    }
});
