/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getCurrentChannel } from "@utils/discord";
import { ChannelType } from "@vencord/discord-types/enums";
import { GuildStore } from "@webpack/common";

export interface Conversation {
    id: string;
    name: string;
    type: ChannelType;
    guildId?: string;
    guildName?: string;
    isDM: boolean;
}

const EXPORTABLE_TYPES = new Set<ChannelType>([
    ChannelType.GUILD_TEXT,
    ChannelType.GUILD_ANNOUNCEMENT,
    ChannelType.DM,
    ChannelType.GROUP_DM,
    ChannelType.PUBLIC_THREAD,
    ChannelType.PRIVATE_THREAD,
    ChannelType.ANNOUNCEMENT_THREAD
]);

export function resolveConversation(): Conversation {
    const channel = getCurrentChannel();
    if (!channel)
        throw new Error("No channel is currently open");

    const { name } = channel;
    const displayName = name
        || channel.rawRecipients?.map(r => r.global_name || r.username).join(", ")
        || "unknown";

    if (!EXPORTABLE_TYPES.has(channel.type))
        throw new Error(`"${displayName}" is not a text channel and cannot be exported`);

    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : undefined;
    const isDM = channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM;

    return {
        id: channel.id,
        name: displayName,
        type: channel.type,
        guildId: guild?.id,
        guildName: guild?.name,
        isDM
    };
}
