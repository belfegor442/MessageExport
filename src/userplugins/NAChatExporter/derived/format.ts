/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 NA Tools and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { getVersions, type StoredMessage, type StoredMessageVersion } from "../core/db";

function pad(value: number, length = 2): string {
    return String(value).padStart(length, "0");
}

export function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatTimeOfDay(ms: number): string {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function flatten(content: string): string {
    return content.replace(/\r?\n/g, " ").replace(/ {2,}/g, " ").trimEnd();
}

type BranchNode = { label: string; children?: BranchNode[]; };

function renderBranches(indent: string, roots: BranchNode[]): string[] {
    const lines: string[] = [];
    for (let i = 0; i < roots.length; i++) {
        const isLast = i === roots.length - 1;
        writeNode(lines, indent, roots[i], "", isLast);
    }
    return lines;
}

function writeNode(lines: string[], indent: string, node: BranchNode, prefix: string, isLast: boolean): void {
    lines.push(`${indent}${prefix}${isLast ? "└── " : "├── "}${node.label}`);
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++)
        writeNode(lines, indent, children[i], childPrefix, i === children.length - 1);
}

function attachmentBranch(message: StoredMessage): BranchNode[] {
    return message.attachments.map(attachment => ({
        label: "ATTACHMENT",
        children: [
            { label: `File: ${attachment.filename}` },
            ...(attachment.contentType ? [{ label: `Type: ${attachment.contentType}` }] : []),
            { label: `Size: ${formatSize(attachment.size)}` },
            ...(attachment.width && attachment.height
                ? [{ label: `Resolution: ${attachment.width} × ${attachment.height}` }]
                : []),
            {
                label: attachment.localPath
                    ? `Local: ${attachment.localPath}`
                    : attachment.downloadState === "failed"
                        ? "Local: not stored (download failed)"
                        : "Local: not stored"
            }
        ]
    }));
}

function embedBranch(message: StoredMessage): BranchNode[] {
    return message.embeds.map(embed => ({
        label: "EMBED",
        children: [
            ...(embed.title ? [{ label: `Title: ${flatten(embed.title)}` }] : []),
            ...(embed.description ? [{ label: `Description: ${flatten(embed.description)}` }] : []),
            ...(embed.provider ? [{ label: `Provider: ${embed.provider}` }] : []),
            { label: "Preview: Available" }
        ]
    }));
}

function stickerBranch(message: StoredMessage): BranchNode[] {
    return message.stickers.map(sticker => ({
        label: "STICKER",
        children: [{ label: `Name: ${sticker.name}` }]
    }));
}

function replyBranch(message: StoredMessage, referenced: StoredMessage | undefined): BranchNode[] {
    if (!message.messageReference) return [];
    const reference = message.messageReference;
    return [{
        label: "REPLY CONTEXT",
        children: [
            { label: referenced ? `Reply to: ${referenced.authorName}` : "Reply to: [not captured]" },
            ...(referenced ? [{ label: `Original time: ${formatTimeOfDay(recentTs(referenced))}` }] : []),
            {
                label: referenced
                    ? `Original message: ${flatten(referenced.content) || "[no text content]"}`
                    : `Original message id: ${reference.messageId}`
            }
        ]
    }];
}

function recentTs(message: StoredMessage): number {
    return message.timestampMs;
}

function pollBranch(message: StoredMessage): BranchNode[] {
    if (!message.poll) return [];
    return [{
        label: "POLL",
        children: [
            { label: `Question: ${flatten(message.poll.question)}` },
            ...message.poll.answers.map(answer => ({ label: `Option: ${answer.text}` })),
            { label: `Multiselect: ${message.poll.allowMultiselect ? "yes" : "no"}` },
            ...(message.poll.expiryMs ? [{ label: `Closes: ${formatTimestamp(message.poll.expiryMs)}` }] : [])
        ]
    }];
}

function reactionsBranch(message: StoredMessage): BranchNode[] {
    if (message.reactions.length === 0) return [];
    return [{
        label: "REACTIONS (current state)",
        children: message.reactions.map(reaction => ({
            label: `${reaction.name} ×${reaction.count}`
        }))
    }];
}

function editHistoryBranch(message: StoredMessage, versions: StoredMessageVersion[]): BranchNode[] {
    if (versions.length === 0) return [];
    return [{
        label: "EDIT HISTORY",
        children: versions.map((version, index) => ({
            label: `Version ${version.version} · ${formatTimeOfDay(index === 0 ? message.timestampMs : version.editedAtMs ?? version.capturedAtMs)}`,
            children: [{ label: flatten(version.content) || "[no text content]" }]
        }))
    }];
}

function deletionBranch(message: StoredMessage): BranchNode[] {
    return [{
        label: "ORIGINAL MESSAGE",
        children: [
            { label: `Created: ${formatTimeOfDay(message.timestampMs)}` },
            ...(message.content ? [{ label: `Content: ${flatten(message.content)}` }] : [])
        ]
    }];
}

/**
 * Renders one message as the approved TXT format: a single chronological line
 * plus selective ASCII branches only when the message carries extra information.
 */
export async function formatMessageLine(message: StoredMessage, referenced?: StoredMessage): Promise<string[]> {
    const prefix = `[${formatTimestamp(message.timestampMs)}] ${message.authorName}: `;

    if (message.deleted) {
        const deleteTs = message.deletedAtMs ?? message.capturedAtMs;
        const deletePrefix = `[${formatTimestamp(deleteTs)}] ${message.authorName}: `;
        const indent = " ".repeat(deletePrefix.length);
        const lines = [`${deletePrefix}[MESSAGE DELETED]`, ...renderBranches(indent, deletionBranch(message))];
        return lines;
    }

    const content = message.edited ? `${flatten(message.content)} [EDITED]` : flatten(message.content);
    const branches: BranchNode[] = [
        ...attachmentBranch(message),
        ...embedBranch(message),
        ...stickerBranch(message),
        ...replyBranch(message, referenced),
        ...pollBranch(message),
        ...reactionsBranch(message)
    ];

    const versions = message.editCount > 0
        ? await getVersions(message.channelId, message.id)
        : [];
    if (versions.length > 0)
        branches.push(...editHistoryBranch(message, versions));

    const indent = " ".repeat(prefix.length);
    return [`${prefix}${content}`, ...renderBranches(indent, branches)];
}

/** Synchronous render for deletion/edit markers, which never need version lookups. */
export function formatDeletionMarker(message: StoredMessage): string[] {
    const deleteTs = message.deletedAtMs ?? Date.now();
    const prefix = `[${formatTimestamp(deleteTs)}] ${message.authorName}: `;
    const indent = " ".repeat(prefix.length);
    return [`${prefix}[MESSAGE DELETED]`, ...renderBranches(indent, deletionBranch(message))];
}

export function formatEditMarker(message: StoredMessage, versions: StoredMessageVersion[], editedAtMs: number | null): string[] {
    const editTs = editedAtMs ?? message.capturedAtMs;
    const prefix = `[${formatTimestamp(editTs)}] ${message.authorName}: `;
    const content = `${flatten(message.content)} [EDITED]`;
    const indent = " ".repeat(prefix.length);
    const branches = versions.length > 0 ? editHistoryBranch(message, versions) : [];
    return [`${prefix}${content}`, ...renderBranches(indent, branches)];
}
