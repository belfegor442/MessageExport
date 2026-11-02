/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Characters invalid in Windows/POSIX path segments
const INVALID_CHARS = /[<>:"/\\|?*]/g;
const CONTROL_CHARS = /[\x00-\x1f]/g;
const TRAILING = /[. ]+$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_LENGTH = 80;

export function sanitizeSegment(name: string): string {
    let s = name.replace(INVALID_CHARS, "_").replace(CONTROL_CHARS, "_").replace(TRAILING, "").trim();

    if (s.length > MAX_LENGTH)
        s = s.slice(0, MAX_LENGTH).replace(TRAILING, "");
    if (!s)
        s = "_";
    if (RESERVED.test(s))
        s = `_${s}`;

    return s;
}
