/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { StoredMessage } from "./db";

export interface DerivedHooks {
    onMessageStored?: (message: StoredMessage) => void;
    onMessageEdited?: (channelId: string, messageId: string) => void;
    onMessageDeleted?: (channelId: string, messageId: string) => void;
}

let hooks: DerivedHooks = {};
let active = false;

export function registerDerivedHooks(next: DerivedHooks): void {
    hooks = { ...hooks, ...next };
}

export function setArchivingActive(next: boolean): void {
    active = next;
}

export function isArchivingActive(): boolean {
    return active;
}

export function emitStored(message: StoredMessage): void {
    if (active) hooks.onMessageStored?.(message);
}

export function emitEdited(channelId: string, messageId: string): void {
    if (active) hooks.onMessageEdited?.(channelId, messageId);
}

export function emitDeleted(channelId: string, messageId: string): void {
    if (active) hooks.onMessageDeleted?.(channelId, messageId);
}
