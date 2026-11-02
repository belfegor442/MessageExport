/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { PluginNative } from "@utils/types";

// Main-process bridge (fs access). Available on Discord Desktop only; callers must handle rejection.
export const Native = VencordNative.pluginHelpers.NAChatExporter as PluginNative<typeof import("../native")>;
