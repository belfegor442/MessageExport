# Remediation validation checklist

Run these regression checks from a Vencord checkout with this plugin copied into `src/userplugins/NAChatExporter`. Static edits alone do not prove runtime correctness.

## Automated gates
- [ ] `pnpm test:ts`
- [ ] `pnpm exec eslint src/userplugins/NAChatExporter`
- [ ] `pnpm build --dev`
- [ ] `pnpm test`

Record the Vencord commit and exact results; do not mark a gate passed if it was not run.

## Filesystem and derived output
- [ ] New server/channel and nested user folders are created; no `ENOENT`.
- [ ] Empty conversation rebuild produces empty TXT, JSON `[]`, and CSV header.
- [ ] Change archive root and verify later writes use the new path.
- [ ] Stop with pending writes, restart, and inspect session/integrity metadata.

## Data integrity
- [ ] First edit preserves original as version 1 and new content as version 2.
- [ ] Repeated edits have strictly increasing versions and exact editCount.
- [ ] A previously uncaptured message first seen in `MESSAGE_UPDATE` queues derived output.
- [ ] Single and bulk deletion markers match derived files.
- [ ] Backfill with cap below API page size never inserts beyond configured cap.
- [ ] Interrupted backfill resumes and deduplicates.
- [ ] Parse CSV containing commas, double quotes, CR/LF, and Unicode with a standards-compliant parser.

## Attachments
- [ ] Download from each allowed CDN host.
- [ ] Reject HTTP, credentials, non-allow-listed hosts, and redirects to other hosts.
- [ ] Reject declared and streamed bodies larger than 50 MiB.
- [ ] Failed downloads retain their source references and report failed state.

## Selected-server boundary
- [ ] Fresh install starts with zero selected guilds.
- [ ] Select one guild; only its channel descriptors are discovered.
- [ ] A live message/reaction/delete/voice event from an unselected guild is ignored.
- [ ] Backfill runs only for selected guild conversations.
- [ ] Deselect a guild while active; capture and backfill stop after reconciliation.
- [ ] Select another guild; it is discovered after selection changes.
- [ ] Existing archive records/files for a deselected guild are retained but not refreshed.
- [ ] Author-derived files contain only messages from currently selected guilds (plus explicitly handled DMs).

## Privacy defaults
- [ ] Fresh install has archiving, history recovery, and attachment downloads disabled.
- [ ] Explicitly enabling each option activates only its documented behavior.
- [ ] Archive contents remain local; documentation explains sensitivity and deletion retention.

## Status
No item is passed merely because this checklist exists.