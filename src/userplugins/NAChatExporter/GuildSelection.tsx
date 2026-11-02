/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Forms, GuildStore } from "@webpack/common";

import { notifyGuildSelectionChanged, settings } from "./settings";

export function GuildSelection() {
    const { selectedGuildIds } = settings.use(["selectedGuildIds"]);
    const selected = new Set<string>(selectedGuildIds ?? []);
    const guilds = GuildStore.getGuildsArray();

    function toggleGuild(id: string, checked: boolean) {
        const next = new Set<string>(settings.store.selectedGuildIds ?? []);
        if (checked)
            next.add(id);
        else
            next.delete(id);
        settings.store.selectedGuildIds = [...next];
        notifyGuildSelectionChanged();
    }

    return (
        <section>
            <Forms.FormTitle tag="h3">Servers included in the archive</Forms.FormTitle>
            <Forms.FormText>
                No server is included automatically. Select each server you explicitly want to archive.
                Unselected servers are ignored by discovery, live capture, and history recovery.
                Existing archive files from a server you later deselect are not automatically deleted.
            </Forms.FormText>
            {guilds.length === 0
                ? <Forms.FormText>You are not currently in any servers.</Forms.FormText>
                : guilds.map(guild => (
                    <label
                        key={guild.id}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            padding: "8px 0",
                            cursor: "pointer"
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={selected.has(String(guild.id))}
                            onChange={event => toggleGuild(String(guild.id), event.currentTarget.checked)}
                        />
                        <span>{guild.name}</span>
                    </label>
                ))}
        </section>
    );
}
