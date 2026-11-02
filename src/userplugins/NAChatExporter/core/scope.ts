/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore } from "@webpack/common";

import { settings } from "../settings";
import { getConversation } from "./db";

export function isGuildSelected(guildId: string | null | undefined): boolean {
    return Boolean(guildId && (settings.store.selectedGuildIds ?? []).includes(String(guildId)));
}

/** A channel is in scope only if its guild was explicitly selected, or it is a DM. */
export async function isChannelInArchiveScope(channelId: string): Promise<boolean> {
    const channel = ChannelStore.getChannel(channelId);
    if (channel) {
        if (channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM)
            return true;

        const parentId = (channel as any).parent_id as string | undefined;
        const parent = parentId ? ChannelStore.getChannel(parentId) : undefined;
        const guildId = channel.guild_id ?? parent?.guild_id;
        return isGuildSelected(guildId);
    }

    const stored = await getConversation(channelId).catch(() => undefined);
    if (!stored) return false;
    return stored.isDM || isGuildSelected(stored.guildId);
}
