# NA Chat Exporter

A private [Vencord](https://vencord.dev) user plugin that automatically archives accessible Discord conversations to local files. IndexedDB is the source of truth; TXT, JSON and optional CSV files are derived exports.

## Features

- Captures new messages, edits, deletions, reactions and observable voice-state changes while the plugin is active.
- Discovers accessible DMs, group DMs, guild text channels, announcement channels and cached threads.
- Optionally recovers accessible message history through Discord's internal REST API:
  - fetches up to 100 messages per page, with a configurable delay
  - waits for the server-provided retry delay on HTTP 429 responses
  - persists pagination cursors so interrupted recovery can resume
  - supports a per-conversation cap on messages recovered by backfill
- Stores messages and edit/reaction history in IndexedDB. Derived files are written under the configured local folder:
  - `Conversations/Servers/<server>/Channels/<channel>/` — conversation TXT/JSON/optional CSV and `Attachments/<type>/`
  - `Conversations/Direct-Messages/<conversation>/` and `Group-Chats/<conversation>/` — conversation logs
  - `System/` — session, event and integrity logs
- Writes live TXT updates within about 100 ms and refreshes JSON shortly after; historical backfill is batched separately.
- Backfill can be toggled while archiving is running; temporary failures are retried with increasing delays, up to 15 minutes.
- Stores display names on each message; it does not create per-user profiles, folders, or a database of all authors.

Archiving is local to the device and requires Vencord's desktop native filesystem bridge. Only data available to the Discord account is captured; messages or events unavailable during downtime cannot be guaranteed.

## Installation

This is a Vencord user plugin. Copy `src/userplugins/NAChatExporter` into the Vencord checkout's `src/userplugins/` directory, then build Vencord:

```powershell
Copy-Item -Recurse -Force src\userplugins\NAChatExporter <vencord>\src\userplugins\NAChatExporter
Set-Location <vencord>
pnpm build --dev
```

Restart Discord and enable **NA Chat Exporter** under **Settings → Vencord → Plugins**.

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `archivingEnabled` | `true` | Start or stop automatic archiving |
| `storageRoot` | `D:/NA-CHAT-EXPORTER` | Local folder for the archive |
| `backfillHistory` | `true` | Recover history still accessible through Discord |
| `downloadSelectedAttachments` | `false` | Download attachments only after enabling this and selecting servers below |
| `attachmentGuildIds` | none | Per-server allowlist for attachment downloads; no server is selected by default |
| `maintainCsv` | `false` | Maintain an additional CSV export |
| `pageDelayMs` | `500` | Delay between backfill requests |
| `maxMessages` | `0` | Maximum backfilled messages per conversation; `0` means unlimited |

## Development

The canonical source is `src/userplugins/NAChatExporter`. Copy it to the Vencord checkout before validating changes:

```powershell
Copy-Item -Recurse -Force src\userplugins\NAChatExporter vencord\src\userplugins\NAChatExporter
Set-Location vencord
pnpm test:ts
pnpm exec eslint src/userplugins/NAChatExporter
pnpm build --dev
```

## Privacy and limitations

- The plugin does not upload archive data or read the Discord token.
- The database migration removes its old author index/store; any old `Users/` folder is left untouched and is no longer written.
- Backfill and live capture use Discord client APIs and respect server rate limits.
- Backfill can only retrieve history Discord makes accessible to the account.
- Attachments are never downloaded from DMs or unselected servers. Existing files in old paths are left untouched and are not moved or deleted.
- Events occurring while Discord or the plugin is stopped are not captured live; history recovery may fill some message gaps if those messages remain accessible.
- This is a private user plugin, not affiliated with Discord or Vencord.

## License

GPL-3.0-or-later; see [LICENSE](LICENSE).
