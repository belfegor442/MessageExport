/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType } from "@vencord/discord-types/enums";
import { ChannelStore, GuildStore } from "@webpack/common";

import { upsertConversation } from "./db";
import { logEvent } from "./events";
import { isGuildSelected } from "./scope";

export const EXPORTABLE_TYPES = new Set<number>([
    ChannelType.GUILD_TEXT,
    ChannelType.GUILD_ANNOUNCEMENT,
    ChannelType.DM,
    ChannelType.GROUP_DM,
    ChannelType.PUBLIC_THREAD,
    ChannelType.PRIVATE_THREAD,
    ChannelType.ANNOUNCEMENT_THREAD
]);

interface ConversationDescriptor {
    id: string;
    type: number;
    name: string;
    guildId: string | null;
    guildName: string | null;
    isDM: boolean;
    recipients: { id: string; username: string; globalName: string | null; }[];
}

function describePrivateChannel(channel: any): ConversationDescriptor | null {
    if (!EXPORTABLE_TYPES.has(channel.type)) return null;

    const recipients = (channel.rawRecipients ?? []).map((r: any) => ({
        id: String(r.id ?? ""),
        username: String(r.username ?? ""),
        globalName: r.global_name ?? r.globalName ?? null
    }));

    const name = channel.type === ChannelType.DM
        ? recipients[0]?.globalName ?? recipients[0]?.username ?? channel.id
        : channel.name || recipients.map((r: any) => r.globalName ?? r.username).join(", ") || channel.id;

    return {
        id: String(channel.id),
        type: channel.type,
        name,
        guildId: null,
        guildName: null,
        isDM: true,
        recipients
    };
}

function describeGuildChannel(channel: any, guildName: string, guildId?: string): ConversationDescriptor | null {
    if (!EXPORTABLE_TYPES.has(channel.type)) return null;

    return {
        id: String(channel.id),
        type: channel.type,
        name: channel.name || channel.id,
        guildId: String(guildId ?? channel.guild_id ?? ""),
        guildName,
        isDM: false,
        recipients: []
    };
}

/** Scans private channels and only the guilds explicitly selected by the user. */
export async function discoverConversations(root: string): Promise<number> {
    const descriptors: ConversationDescriptor[] = [];
    const seen = new Set<string>();

    for (const channel of ChannelStore.getSortedPrivateChannels()) {
        const descriptor = describePrivateChannel(channel);
        if (!descriptor || seen.has(descriptor.id)) continue;
        seen.add(descriptor.id);
        descriptors.push(descriptor);
    }

    for (const guild of GuildStore.getGuildsArray()) {
        if (!isGuildSelected(String(guild.id))) continue;
        const guildName = guild.name;
        const channels = Object.values(ChannelStore.getMutableGuildChannelsForGuild(guild.id));
        const threads = ChannelStore.getAllThreadsForGuild(guild.id);
        for (const channel of [...channels, ...threads]) {
            const descriptor = describeGuildChannel(channel, guildName, String(guild.id));
            if (!descriptor || seen.has(descriptor.id)) continue;
            seen.add(descriptor.id);
            descriptors.push(descriptor);
        }
    }

    for (const descriptor of descriptors)
        await upsertConversation(descriptor);

    logEvent(root, "conversations_discovered", { count: descriptors.length });
    return descriptors.length;
}

export function describeChannelById(channelId: string): ConversationDescriptor | null {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return null;

    if (channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM)
        return describePrivateChannel(channel);

    const parentId = (channel as any).parent_id as string | undefined;
    const parent = parentId ? ChannelStore.getChannel(parentId) : undefined;
    const guildId = channel.guild_id ?? parent?.guild_id;
    const guild = guildId ? GuildStore.getGuild(guildId) : undefined;
    return describeGuildChannel(channel, guild?.name ?? "", guildId);
}
