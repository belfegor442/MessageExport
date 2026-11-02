# Remediation validation checklist

This checklist covers the regression cases identified in the code audit. Run it from a Vencord checkout with this plugin copied into `src/userplugins/NAChatExporter`. Static source edits alone are not proof of runtime correctness.

## Automated gates

- [ ] `pnpm test:ts`
- [ ] `pnpm exec eslint src/userplugins/NAChatExporter`
- [ ] `pnpm build --dev`
- [ ] `pnpm test`

Record the exact Vencord commit, command, and result. Do not mark a gate passed if it was not run.

## Archive filesystem

- [ ] Create a brand-new server/channel directory and verify TXT, JSON, and optional CSV files are created without `ENOENT`.
- [ ] Verify nested user profile directories are created.
- [ ] Rebuild an empty conversation: `Chat.txt` exists as an empty file, `Chat.json` contains `[]`, and CSV contains its header.
- [ ] Change the archive root and verify subsequent writes use the new root.
- [ ] Stop Discord while writes are pending; restart and inspect the archive/session integrity report.

## Message data integrity

- [ ] Capture a message, edit it once, and verify the original content is version 1 and edited content is version 2.
- [ ] Edit the same message multiple times; verify versions are strictly increasing and `editCount` increments exactly once per edit.
- [ ] Deliver a `MESSAGE_UPDATE` for a message not already in IndexedDB; verify derived output is scheduled.
- [ ] Delete one message and bulk-delete several; verify the stored deletion markers and derived files match the documented retention behavior.
- [ ] Recover a conversation with a configured history cap smaller than a fetched page; verify newly inserted messages do not exceed the cap.
- [ ] Interrupt backfill and resume it; verify cursor progress and deduplication.
- [ ] Parse CSV using a standards-compliant parser with commas, quotes, CR/LF, and Unicode in message content.

## Attachment boundary

- [ ] Download a small file from each approved CDN host.
- [ ] Reject HTTP, credentials in URL, non-approved host, and a redirect whose final URL is outside the allow-list.
- [ ] Reject a declared attachment larger than 50 MiB.
- [ ] Reject a streamed body that crosses 50 MiB even when Content-Length is absent or inaccurate.
- [ ] Verify failure leaves the attachment reference intact and marks download state as failed.

## Privacy / behavior

- [ ] On a fresh install, archiving, history recovery, and attachment downloading are disabled.
- [ ] Enable each feature explicitly and confirm it behaves according to its setting.
- [ ] Confirm archive content remains local and that documentation explains sensitivity and deletion retention.

## Current status

No checklist item is considered passed by the presence of this document. Record results after executing the tests.
