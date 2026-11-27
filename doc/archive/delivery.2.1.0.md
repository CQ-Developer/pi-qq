# pi-qq delivery 2.1.0

> **Delivery record.** 2.1.0 is a code-review maintenance release: it fixes final-delivery reporting, bounds relay and pending-attachment state, adds log/upload retention, fixes diagnostic budget accounting, tightens peer metadata, and removes the legacy `debug` alias. No QQ protocol behavior changed. See [README](../../README.md) for current user-facing behavior.
> Version: 2.1.0
> Date: 2026-11-28
> Previous: [delivery.2.0.0.md](./delivery.2.0.0.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

2.1.0 is the execution of the repository-wide code review recorded before implementation:

- Correct final-delivery semantics when stream `DONE` is rejected.
- Bound long-lived in-memory and on-disk state: `msg_seq`, pending attachments, upload directories, and logs.
- Correct local reply-budget accounting for diagnostic commands.
- Fix package metadata for host-provided imports.
- Remove the legacy `debug` config alias and stale log metadata.
- Cache config reads by file mtime.
- Remove full media paths and raw voice transcripts from debug logs.
- Defer the four large structural refactors.

Out of scope:

- QQ protocol, stream framing, rotation, or recovery semantics.
- Real-QQ re-verification of the 2.0.0 stream behavior; this release changes internal state and diagnostics only.
- `BubbleWriter`, `RunFeedback`, `index.ts`, and `media-tool.ts` structural splits.
- TypeScript 7.

## 2. Findings and history

The review covered all sources, tests, package/CI configuration, and documentation. Commit history was used to separate confirmed defects from deliberate design decisions:

| Finding                                                        | History check                                                                        | Outcome                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| `done()` swallowed DONE errors; `delivered` was set regardless | `c4ab328` introduced the swallow; `98df2df` added `delivered` without reconciling it | Confirmed and fixed                     |
| Missing `pi-ai`/`typebox` peer declarations                    | `8528d4f` added the imports; peer metadata was never updated                         | Confirmed and fixed                     |
| Unbounded `msg_seq` map                                        | Introduced by `a1ecf2e`; no eviction                                                 | Fixed with LRU cap and TTL              |
| Unbounded pending attachments                                  | Introduced by `9d41218`; no cap/TTL                                                  | Fixed                                   |
| No log or upload retention                                     | Logging became async in `2ccd5f1`, but no retention was added                        | Fixed                                   |
| Diagnostics bypassed reply budget                              | Intentional user-facing diagnostics (`bfc1cf3`, `c39ac657`), but no accounting       | Fixed without removing the commands     |
| SDK log summarization in `infra`                               | Deliberately centralized in `2b6878f` for redaction                                  | Kept                                    |
| Legacy `debug` alias                                           | Deliberately retained when `thinkingRelay` was removed (`3223b8e`)                   | Removed; use `logLevel`                 |
| Large relay/entrypoint units                                   | `c4ab328` and `20bef16` already split/grouped deliberately                           | Marked as refactor candidates, deferred |

No dead modules, commented-out production code, unused npm dependencies, or circular imports were found.

## 3. Decisions

| #   | Question                                    | Decision                                                                                                                            |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What does `delivered` mean when DONE fails? | `false`; the recovery target remains available for `/last` or a later run.                                                          |
| D2  | How is `msg_seq` state bounded?             | 24-hour TTL plus a 1,000-entry LRU cap. The longer TTL avoids resetting sequences for long-running messages; the cap bounds memory. |
| D3  | How are pending attachments bounded?        | At most 10 files with a 10-minute TTL. The oldest files are dropped and the user is notified.                                       |
| D4  | What is the upload retention?               | Session upload directories older than 7 days are removed on startup.                                                                |
| D5  | What is the log retention?                  | Keep the newest 7 days or 50 MiB per log directory, whichever is smaller.                                                           |
| D6  | How are diagnostics accounted?              | Keep the documented `/qq-test-*` commands, but record passive replies and stream bubbles in the local budget.                       |
| D7  | Are `pi-ai`/`typebox` optional peers?       | No; both are required host-provided peers with `"*"`.                                                                               |
| D8  | Is the legacy `debug` alias kept?           | No. `logLevel` is the supported setting. Old configs are ignored rather than rejected.                                              |
| D9  | How is config read?                         | Cache the parsed result by mtime and size; re-read only when the file changes.                                                      |
| D10 | Are media paths/voice transcripts logged?   | No full paths; transcript length only. Media display name, type, and size remain.                                                   |
| D11 | Are major refactors included?               | No; deferred until the behavior and state changes have settled.                                                                     |

## 4. Implementation

| Area                      | Files                                                                                                        | Change                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Final delivery            | `src/relay/bubble-writer.ts`, `src/relay/run-stream-relay.ts`                                                | `done()` returns success; `delivered` depends on it; recovery is cleared only after successful delivery. |
| `msg_seq`                 | `src/relay/msg-seq.ts`                                                                                       | 24 h TTL, 1,000-entry LRU cap, injected clock for tests.                                                 |
| Pending attachments       | `src/qq/inbound-attachments.ts`, `src/qq/qq-message-handler.ts`, `src/infra/i18n.ts`                         | 10-file cap, 10-minute TTL, drop notification.                                                           |
| Upload retention          | `src/attachments/file-attachments.ts`, `index.ts`                                                            | `pruneSessionUploads()` removes old session directories.                                                 |
| Log retention and privacy | `src/infra/file-logger.ts`, `src/qq/media-tool.ts`, `src/qq/inbound-attachments.ts`                          | `pruneLogs()`; no full media paths; transcript length only.                                              |
| Diagnostics               | `src/qq/qq-diagnostics.ts`                                                                                   | Commit passive replies and stream bubbles to the budget.                                                 |
| Package metadata          | `package.json`, `package-lock.json`                                                                          | `pi-ai`/`typebox` peers; narrower exports; schema test.                                                  |
| Config                    | `src/infra/settings.ts`                                                                                      | mtime/size cache; remove `debug`; preserve parse-error handling.                                         |
| Readability               | `src/qq/status-report.ts`, `src/relay/run-stream-relay.ts`, `src/qq/media-tool.ts`, `src/qq/reply-sender.ts` | Battery lookup, target helper, media send helper, surrogate-safe chunking, localized upload progress.    |
| Documentation             | `README.md`, `README-zh.md`, `CHANGELOG.md`                                                                  | Log retention/privacy and `logLevel` behavior.                                                           |

## 5. Verification

### 5.1 Automated

- 27 test files, **277 tests passed**.
- `npm ci` passes with the new peer metadata.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm pack --dry-run` pass.
- `knip` reports no unused exports, unlisted dependencies, or unused files.
- New tests cover DONE failure, `msg_seq` TTL/cap, pending attachment cap/TTL, upload retention, log retention, diagnostics budget, media schema, media path privacy, and surrogate-safe chunking.

### 5.2 Behavioral scope

- No QQ protocol or stream framing changes.
- The 2.0.0 real-QQ verification remains the latest protocol test; 2.1.0 changes are internal state, logging, and diagnostics.
- DONE-failure and bounded-state behavior are covered by unit tests; no new real-QQ run was performed for this release.

## 6. Risks and limitations

| Risk                   | Impact                                                                                      | Handling                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Legacy `debug` config  | Old configs now fall back to `silent` logging                                               | Use `logLevel: "debug"`; old key ignored rather than rejected.                                      |
| `msg_seq` TTL/cap      | A message idle for more than 24 h can lose its sequence history                             | Platform `msg_id` validity beyond 1 h remains unverified; active messages are kept by LRU.          |
| Pending attachment cap | A user sending more than 10 attachment-only messages loses the oldest files from the prompt | The oldest files are dropped and the user is notified; files remain on disk until upload retention. |
| Log/upload retention   | Old logs and upload files are deleted                                                       | 7-day retention; current session is preserved.                                                      |
| Required peers         | Installing outside Pi may pull `pi-ai`/`typebox` or warn                                    | Pi supplies them; package metadata now states the contract.                                         |
| No real-QQ retest      | Internal-state changes are not exercised against the platform in 2.1.0                      | Keep the 2.0.0 protocol verification and TODO observations; run real QQ when testing long sessions. |
| Deferred refactors     | Large relay/entrypoint units remain                                                         | Keep tests and state bounds stable before splitting.                                                |

## 7. Open items

Active work is tracked in [doc/todo.md](../todo.md):

- `msg_id` validity beyond one hour.
- `40034020` recovery under real network jitter, reconnects, and rate limiting.
- The cause of duplicate `msg_seq` (`40054005`).

## 8. References

- Code review execution: `0c7dcc7 fix!: address code review findings`.
- Previous delivery: [delivery.2.0.0.md](./delivery.2.0.0.md).
- Code: `src/relay/bubble-writer.ts`, `src/relay/run-stream-relay.ts`, `src/relay/msg-seq.ts`, `src/infra/file-logger.ts`, `src/infra/settings.ts`, `src/qq/inbound-attachments.ts`, `src/qq/qq-diagnostics.ts`.
- Tests: `test/relay`, `test/infra`, `test/qq`.
