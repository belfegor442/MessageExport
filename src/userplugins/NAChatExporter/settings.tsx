/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { Checkbox, GuildStore, useStateFromStores } from "@webpack/common";

type LifecycleHooks = {
    onArchivingToggled?: (enabled: boolean) => void;
    onBackfillHistoryChanged?: (enabled: boolean) => void;
    onStorageRootChanged?: () => void;
    onAttachmentGuildsChanged?: () => void;
};

let hooks: LifecycleHooks = {};

export function registerLifecycleHooks(next: LifecycleHooks): void {
    hooks = next;
}

function AttachmentGuildPicker(props: { setValue: (value: string) => void; }) {
    const guilds = useStateFromStores([GuildStore], () => GuildStore.getGuildsArray());
    const selectedIds = new Set(
        (settings.use(["attachmentGuildIds"]).attachmentGuildIds ?? "")
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)
    );

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span>Attachments are off until enabled and at least one server is selected.</span>
            {guilds.map(guild => {
                const id = String(guild.id);
                return (
                    <Checkbox
                        key={id}
                        value={selectedIds.has(id)}
                        onChange={(_, checked) => {
                            const next = new Set(selectedIds);
                            if (checked) next.add(id);
                            else next.delete(id);
                            props.setValue([...next].sort().join(","));
                        }}
                    >
                        <span>{guild.name}</span>
                    </Checkbox>
                );
            })}
            {guilds.length === 0 && <span>No servers are available in the Discord client.</span>}
        </div>
    );
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
        description: "Recover message history that is still accessible via Discord's API",
        default: true,
        onChange: value => hooks.onBackfillHistoryChanged?.(Boolean(value))
    },
    downloadSelectedAttachments: {
        type: OptionType.BOOLEAN,
        description: "Download attachments only from the servers selected below (references are always kept)",
        default: false,
        onChange: () => hooks.onAttachmentGuildsChanged?.()
    },
    attachmentGuildIds: {
        type: OptionType.COMPONENT,
        default: "",
        component: props => <AttachmentGuildPicker setValue={props.setValue} />,
        onChange: () => hooks.onAttachmentGuildsChanged?.()
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
