# NA Chat Exporter

Vencord user plugin for local archiving of Discord conversations. The archive uses renderer IndexedDB as its primary store; TXT/JSON and optional CSV files are derived outputs.

> **Development status:** active development. It archives only content accessible through Discord client events or its API. It is not a guaranteed complete account export.

## Privacy, consent, and scope

**All collection is opt-in.** Automatic archiving, history recovery, and attachment downloads are disabled by default. In plugin settings, select the specific servers you want included. No server is selected automatically.

Unselected servers are excluded from conversation discovery, live message capture, reactions/deletions/voice event handling, and history recovery. Changing the selection restarts discovery to reconcile the active scope.

- Review the archive destination before enabling.
- The archive may contain private messages, names, attachments, and deletion markers. Keep it private.
- Deselecting a server stops new collection from it, but does not automatically delete existing records/files for that server. Purge old content manually if you no longer want to retain it.
- The plugin does not intentionally upload archive contents. Optional attachment downloads make requests to approved HTTPS Discord CDN hosts.
- Archiving every server can consume substantial disk space. Select only the servers you need.

Direct messages and group DMs are currently handled separately from guild selection and may be archived when automatic archiving is enabled.

## Features

- Captures supported live message creation, edits, deletion markers, reactions, and observable voice-state events.
- Optionally recovers accessible history through Discord's API with backward pagination and a configurable delay.
- Deduplicates messages by `(channelId, messageId)`.
- Stores source records in IndexedDB (`NAChatExporterArchive`).
- Maintains derived TXT/JSON exports and optional CSV.
- Preserves attachment references; optional downloads are restricted to approved HTTPS Discord CDN hosts and 50 MiB per file.
- Writes session and integrity metadata under the configured archive root.

### Limitations

- Only messages/events accessible to the current Discord client/account can be archived.
- Data no longer served by Discord cannot be recovered.
- Historical reactions are not reconstructed.
- Live events are not received while Discord is closed.
- A channel/server being selected does not guarantee a complete export; API permissions, availability, rate limits, and client changes can affect collection.

## Installation

This is a Vencord user plugin.

1. Copy `src/userplugins/NAChatExporter` into your Vencord checkout's `src/userplugins/` directory.
2. Build Vencord from its repository root:

   ```powershell
   pnpm build --dev
   ```

3. Restart Discord completely.
4. Open **Settings → Vencord → Plugins → NA Chat Exporter**.
5. In **Servers included in the archive**, select only the guilds you want. Enable archiving separately.
6. Enable history recovery and attachment downloads only if required.

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `selectedGuildIds` | `[]` | Guilds explicitly approved for collection |
| `archivingEnabled` | `false` | Enable local archiving |
| `storageRoot` | `D:/NA-CHAT-EXPORTER` | Local archive directory |
| `backfillHistory` | `false` | Recover history accessible through Discord's API |
| `downloadAttachments` | `false` | Download supported CDN attachments (50 MiB/file maximum) |
| `maintainCsv` | `false` | Maintain CSV alongside TXT and JSON |
| `pageDelayMs` | `500` | Delay between history requests (100–2000 ms) |
| `maxMessages` | `0` | Recovery cap per conversation; `0` means unlimited |

## Archive layout

The configured root contains system/session metadata, derived conversation exports, author profiles, and optional attachment files. Conversation paths are sanitized and IDs are used to disambiguate collisions.

- `System/Events.jsonl` — append-only event log.
- `System/Recording-Sessions.json` — session lifecycle and counters.
- `System/Integrity.json` — latest integrity report.
- `Conversations/` — per-conversation TXT/JSON and optional CSV.
- `Users/` — author profile and scoped message files.
- `Attachments/` — optional downloaded attachments.

The IndexedDB database is the primary source of truth. Files are derived outputs and may be rebuilt. Selecting/deselecting servers does not purge the historical archive automatically.

## Validation

Run from a Vencord checkout with the plugin installed:

```powershell
pnpm test:ts
pnpm exec eslint src/userplugins/NAChatExporter
pnpm build --dev
pnpm test
```

Also verify the regression scenarios in [docs/remediation-validation.md](docs/remediation-validation.md). These checks must be executed before treating changes as validated; static edits alone do not prove runtime behavior.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Not affiliated with Discord, Vencord, or Vendicated.
