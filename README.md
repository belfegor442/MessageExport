# NA Chat Exporter

A private [Vencord](https://vencord.dev) user plugin that exports Discord conversations **message by message** with full metadata and an explicit integrity manifest — an incomplete export is never presented as complete.

> **Status:** active development. The plugin archives supported accessible conversations locally, captures live events, can recover API-accessible history, and maintains derived TXT/JSON with optional CSV. It is not a guaranteed complete account export.

## Privacy and consent

Automatic archiving, history recovery, and attachment downloads are opt-in and disabled by default. The archive may contain private messages, usernames, attachments, and deletion markers. Review the storage path and keep the folder private before enabling it. Deleted messages may remain in the local archive marked as deleted; this project does not provide a retention or purge system. The plugin does not intentionally upload archive contents; optional attachment downloads request Discord CDN hosts.

## What it does

- Archives supported conversations discovered from the Discord client and incoming events; the primary store is renderer IndexedDB (`NAChatExporterArchive`), and local TXT/JSON/CSV files are derived exports.
- Collects history through Discord's internal REST API (`GET /channels/{id}/messages`), **not** the client cache:
  - paginates backwards with a `before` cursor, 100 messages per page
  - configurable delay between requests (default 500 ms) — gentle on Discord
  - on HTTP 429 it **waits** the server-provided `retry_after` and retries (up to 3 attempts); no rate-limit evasion
  - deduplicates messages across page boundaries and stalls safely if the cursor stops advancing
  - optional safety cap (`maxMessages`, 0 = unlimited)
- Captures supported live message events, edits, deletion markers, reactions, and observable voice-state events. CSV maintenance is optional.

### Integrity manifest

```json
{
  "schema": "na-chat-export/1",
  "generatedAt": "2026-11-01T12:00:00.000Z",
  "conversation": { "id": "...", "name": "...", "type": 0, "guildId": "...", "guildName": "...", "isDM": false },
  "integrity": {
    "status": "complete | truncated | partial",
    "stopReason": "reached_beginning | max_messages | error",
    "pagesFetched": 12,
    "failedFetches": 0,
    "deduplicatedMessages": 0,
    "messageCount": 1137,
    "newestId": "...",
    "oldestId": "...",
    "error": null
  },
  "messages": [ /* raw Discord API message objects */ ]
}
```

- `complete` — pagination reached the beginning of the channel with **zero** failed requests.
- `truncated` — stopped at your `maxMessages` cap (exports the most recent N messages).
- `partial` — at least one page failed after retries; the export is explicitly flagged as incomplete.

## Installation

This is a **user plugin** — it is discovered automatically by Vencord's build, no registration needed.

1. Clone this repository into your Vencord checkout's `src/userplugins/` folder (or copy the `src/userplugins/NAChatExporter` folder there):

   ```powershell
   git clone https://github.com/belfegor442/MessageExport.git <vencord>/src/userplugins/MessageExport
   ```

2. Build Vencord (from the Vencord repo root):

   ```powershell
   pnpm build --dev
   ```

3. Restart Discord completely (tray → Quit, then reopen).

4. Enable it: **Settings ⚙ → Vencord → Plugins → NA Chat Exporter**.

## Usage

1. Open the conversation you want to export.
2. **Settings ⚙ → Vencord → Plugins → NA Chat Exporter → "Export current conversation (JSON)"**.
3. Choose where to save the file.

Settings:

| Setting | Default | Purpose |
|---|---|---|
| `archivingEnabled` | false | Enable automatic local archiving (opt-in) |\n| `backfillHistory` | false | Recover API-accessible history (opt-in) |\n| `downloadAttachments` | false | Download Discord CDN attachments (opt-in; 50 MiB maximum per file) |\n| `maintainCsv` | false | Maintain CSV output in addition to TXT and JSON |\n| `pageDelayMs` | 500 | Delay between history requests (100–2000 ms) |
| `maxMessages` | 0 | Safety cap per export (0 = no limit) |
| `defaultFormat` | JSON | Preselected format for the (planned) export dialog |

## Development

The canonical source lives in this repository; it is copied into a local Vencord checkout for building:

```powershell
# from the workspace root
Copy-Item -Recurse -Force src\userplugins\NAChatExporter vencord\src\userplugins\NAChatExporter

# gates (from the vencord folder)
pnpm test:ts                                  # typecheck
pnpm exec eslint src/userplugins/NAChatExporter # lint
pnpm build --dev                              # build
pnpm test                                     # full suite
```

Then restart Discord and check the plugin log in the console (`NAChatExporter: ...`).

## Security & privacy

- **Local only** — exports never leave your machine; the plugin performs no uploads.
- **No token access** — the token is never read or logged.
- **No selfbot / spam / rate-limit evasion** — requests are paced and rate limits are respected by waiting.
- Standard Discord client APIs only (Vencord plugin APIs + Discord's internal REST client).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Every source file carries the license header.

Not affiliated with Discord, Vencord or Vendicated.
