# pi-qq delivery 1.7.2

> **Delivery record.** 1.7.2 shrinks debug logs, makes short IDs unique, and fixes `/status` battery reporting on Windows. See [README](../../README.md) for current user-facing behavior.
> Version: 1.7.2
> Date: 2026-11-19
> Previous: [delivery.1.7.1.md](./delivery.1.7.1.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

1.7.2 is a maintenance release driven by the 2026-11-19 real-QQ debug log (7 h 01 min, 17 runs, 246 tool calls, 18 inbound messages):

- run diagnostics repeated the full tool list on every event; one field accounted for 46% of the file;
- "short" message IDs collapsed to a constant value, so logs could not be correlated with inbound messages;
- per-frame stream logs dominated the remaining volume;
- `/status` omitted the battery line on Windows because a 500 ms synchronous probe killed PowerShell;
- several diagnostic fields were misleading: `bubble split` logged zeroed stats, `run ended` reported zero lengths before the final DONE, the first `append` logged an epoch-sized `elapsed`, and the event-loop metric had a fixed ~100 ms floor.

The release also documents passive-reply quota semantics and `full`-mode message density.

Out of scope:

- changes to stream framing, rotation, or lifetime behavior;
- new quota enforcement, typing changes, or stream-frame protocol changes;
- masking stable account identifiers (`senderId`, `openid`, `appId`);
- confirming how the QQ client renders very long commands.

## 2. Findings

### 2.1 Log volume

Baseline: 18,452 lines / 7.64 MiB for 43.0 active minutes (about 10.6 MiB per active hour).

| Scope    | Lines |    Size | Share |
| -------- | ----: | ------: | ----: |
| `run`    | 1,288 | 4.5 MiB |   59% |
| `stream` | 7,520 | 1.7 MiB |   22% |
| `qqbot`  | 7,770 | 1.1 MiB |   14% |

The `tools` field alone was 3.51 MiB (46.0%) across 1,254 lines; the largest line was 11.1 KiB with 86 tools. `run: tool start` and `run: tool end` were each logged twice per tool.

### 2.2 Short IDs

- `logMsgId()` used `messageId.slice(0, 8)`: 7,571 lines logged `ROBOT1.0`, while 79 lines elsewhere kept the full 117-character ID.
- The first fix used the first 8 characters after the last underscore. The 2026-11-19 log then showed two different inbound messages with the same short ID (`UMkNSaLL`).
- Full IDs from the baseline explain why: QQ message IDs are `ROBOT1.0_` + a 21-character constant head + a variable middle + a ~35-character constant tail (16 of 18 IDs ended with `3ngGb.Wl-sLP-ZQpRmBmM!`). Slicing either edge collides.
- Final rule: `sha256(id)` truncated to 8 hexadecimal characters. The same ID maps to the same value in every scope, and the raw ID is not logged.

### 2.3 Battery status

- `/status` at 01:39:29.707 was answered at 01:39:30.220 (513 ms), with no battery line.
- Reproducing the code path returned `ETIMEDOUT SIGTERM` after 520 ms; PowerShell plus `Get-CimInstance Win32_Battery` took 556–669 ms.
- The timeout, not a missing battery, caused the omission.
- On Linux the same call reads `/sys/class/power_supply` and was unaffected.

### 2.4 Diagnostics

- `run ended` reported `finalizedTextLen=0 / resultSentLen=0` while the same instant showed 980 / 980, because the assistant handler reset both before the run-end log; the log also preceded the final DONE.
- 438 of 1,375 `append` lines logged `elapsed=1795049015062` (`Date.now() - 0`).
- 421 `bubble split` lines logged zeroed stats and no rotation reason.
- 516 event-loop samples had p50/p90/p99 of 112/114/120 ms and were uncorrelated with log volume (r = 0.007); only two spikes (363 and 617 ms) stood out. Node's histogram `mean` has a floor roughly equal to `resolution`, so `resolution: 100` produced the constant ~100 ms baseline.
- Every inbound message produced two `message received` lines (debug + info), and each tool event produced two debug lines 1–2 ms apart.

## 3. Decisions

| #   | Question                                            | Decision                                                                                                                                                                                           |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How are short IDs derived?                          | SHA-256 of the full ID, first 8 hex characters. Only fields at least 16 characters long are hashed, so already-short values are not hashed twice. `senderId`, `openid`, and `appId` stay complete. |
| D2  | What does run diagnostics include?                  | At most five tools (latest three finished plus the active one), mapped to `id`, `name`, and state; no arguments or results.                                                                        |
| D3  | When is a takeover decision logged?                 | Only when `textLength > 0` or `streamTookOver=false`.                                                                                                                                              |
| D4  | Which stream frame logs remain?                     | Keep aggregate `stream timing`, slow frames (≥1 s), partial frames (`remaining > 0`), retries, and warnings. Remove routine `append`, `timer`, `flush: start`, and non-partial `flush: done`.      |
| D5  | What about the first `append` elapsed value?        | Removed with D4; no remaining `elapsed` path.                                                                                                                                                      |
| D6  | What does `bubble split` record?                    | Size, last block kind, trailing-newline state, and the rotation reason (`thinking`, `text`, `tool`, `skill`, `split`, `restart`), captured before reset.                                           |
| D7  | When is `run ended` logged?                         | After the final `flush` / `done`, with `delivered`, `lastFinalizedTextLen`, and `lastResultSentLen`; the separate `finished` line is merged.                                                       |
| D8  | How is the event loop measured?                     | `resolution: 1` plus `performance.eventLoopUtilization()`.                                                                                                                                         |
| D9  | Which duplicate lines are merged?                   | One tool start/end line per transition (with `queueWaitMs`), one full inbound `message received` at info level, one `run ended`. `agent` info lines remain because they serve the info log level.  |
| D10 | Do stream bubbles consume the local passive budget? | No. The limiter records text replies only; `/status` labels `passiveRemaining` as text replies only and keeps `estimated = remaining - streamBubbles` as the conservative value.                   |
| D11 | Should `full` mode emit fewer bubbles?              | No. Document that each block is a separate message and that `simple` reduces volume.                                                                                                               |
| D12 | How is the 600 s boundary verified?                 | One controlled 11-minute silent bash tool on real QQ, expecting `40034020`, a fresh stream, buffer replay, and delivery.                                                                           |
| D13 | How is battery read?                                | Async `execFile` with a 3 s timeout and a 30 s cache; `getStatusLines()` is async; failures log platform, code, and signal at debug under the always-allowed `power` scope.                        |

## 4. Implementation

| Area         | Files                                                                | Change                                                                                                                                              |
| ------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Short IDs    | `src/infra/short-id.ts`, `src/infra/file-logger.ts`                  | SHA-256 prefix helper; log writer hashes `messageId`, `msgId`, and `streamMsgId` values of at least 16 characters.                                  |
| Diagnostics  | `src/relay/run-timeline.ts`, `src/relay/run-stream-relay.ts`         | Snapshot-capped tool list without args/results; takeover filter; one tool line per transition; `run ended` after DONE with delivered/last counters. |
| Stream logs  | `src/relay/stream-session.ts`, `src/relay/bubble-writer.ts`          | Remove per-frame logs; add slow/partial summaries; record split reason and pre-reset size; keep aggregate timing.                                   |
| Event loop   | `index.ts`                                                           | 1 ms histogram and `eventLoopUtilization`.                                                                                                          |
| Inbound logs | `src/qq/qq-message-handler.ts`                                       | One info-level `message received` after the allowlist check, with the previous debug fields.                                                        |
| Battery      | `src/infra/power-status.ts`, `index.ts`, `src/qq/inbound-command.ts` | Async probe, 3 s timeout, 30 s cache, async `getStatusLines()`, failure debug log.                                                                  |
| User docs    | `README.md`, `README-zh.md`, `src/infra/i18n.ts`                     | Quota wording, `full`-mode density, battery in `/qq-status` description.                                                                            |

## 5. Verification

### 5.1 Automated

- 25 test files, **259 tests passed**.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm pack --dry-run` pass.
- New coverage: SHA-256 short IDs (including two real IDs with the same head and tail), ID hashing in the log writer, capped diagnostics without args/results, absence of per-frame append logs, partial-frame summary, battery cache and failure fallback, and the updated `/status` wording.

### 5.2 Real QQ: 600 s expiry

Environment: WSL Linux; pi 1.5.2; Node.js 24.22.0; local `main`; one C2C user. Test tool: `sleep 660; echo done`.

| Time (UTC)   | Event                                                                                |
| ------------ | ------------------------------------------------------------------------------------ |
| 10:03:31.949 | `bash` tool starts; stream opens; first frame 200 (46 chars)                         |
| 10:03:32.445 | append done, 495 ms                                                                  |
| 10:14:32.018 | tool ends after 660,055 ms; result frame POST                                        |
| 10:14:32.734 | `400 Bad Request`, `40034020`, `expired: true`, `lastFrameAgeMs=660291`              |
| 10:14:33.442 | fresh stream `resumed: true`, `index=0`, no `stream_msg_id`, 17-char buffer replayed |
| 10:14:34.222 | fresh stream 200; result delivered                                                   |
| 10:14:34.992 | final `OK` 200; `run ended` `delivered: true` after 664,392 ms                       |

A QQ screenshot confirmed the `bash` bubble, the `done` result, the final `OK`, and the battery line (`99% (discharging)`). The recovered result arrives as a new bubble without the original `bash` header.

### 5.3 Battery on Windows

The actual `power-status.ts` was run under Windows Node 24.21 against a real battery:

- success: `{"percent":100,"state":"ac"}`, 556 ms;
- timeout forced to 1 ms: `power status read failed { platform: 'win32', killed: true, signal: 'SIGTERM' }`, returns `undefined` without throwing.

### 5.4 Log after the change

- 188 lines / 43.6 KiB for the 11.1-minute run; the baseline was 7.64 MiB for 43 active minutes.
- `event-loop` is now the largest scope (133 lines / 26.2 KiB); `run` 5.1 KiB, `stream` 5.0 KiB, `qqbot` 2.8 KiB.
- No `append:`, `timer:`, `flush: start`, `flush: done`, `content_raw`, `textPreview`, `"args"`, or `"result"`.
- Event loop: mean 1.11 ms, worst `max` 86 ms, mean utilization 2.26% (max 6.20%).
- The test log predates the SHA-256 change and still shows `UMkNSaLL`; the hash rule is covered by unit tests with the real colliding IDs.

## 6. Risks and limitations

| Risk                       | Impact                                                                    | Handling                                                           |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Hashed IDs                 | Short IDs cannot be compared to raw platform IDs without hashing them     | Recompute `sha256(id)[:8]` when correlating with an external error |
| Expiry test coverage       | One account, one network, one client; QQ rendering and lifetime may vary  | Recovery path is defensive; keep the long-term observation in TODO |
| Long command rendering     | Commands over ~500 characters may still be collapsed by the QQ client     | Pending A/B in TODO 1                                              |
| `msg_id` beyond 20 minutes | One-hour-old inbound messages are unverified                              | Long-term observation                                              |
| Typing timeout             | A 10 s timeout was seen earlier but not reproduced                        | Typing is skipped while a stream is active                         |
| Event-loop log share       | 60% of the new log is the 5 s event-loop sample                           | Candidate for threshold logging or a 30 s cadence                  |
| `/status` logging          | Command replies outside a run are gated off (`outbound` / `qqbot`)        | Verified by screenshot; allowing `outbound` is an open option      |
| Recovery bubble            | The recovered tool result appears in a new bubble without its tool header | Accepted; the original bubble cannot accept frames after expiry    |

## 7. Open items

Active work is tracked in [doc/todo.md](../todo.md):

- confirm QQ rendering for a 500+ character bash command;
- observe stream lifetime and `msg_id` validity beyond 20 minutes and one hour;
- reproduce the typing timeout;
- reduce event-loop log volume;
- decide whether `/status` replies should be logged outside runs.

## 8. References

- Stream endpoint: `https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html`
- Error codes: `https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html`
- Code: `src/infra/short-id.ts`, `src/infra/file-logger.ts`, `src/infra/power-status.ts`, `src/relay/run-timeline.ts`, `src/relay/run-stream-relay.ts`, `src/relay/bubble-writer.ts`, `src/relay/stream-session.ts`, `index.ts`.
- Tests: `test/infra/short-id.test.ts`, `test/infra/file-logger.test.ts`, `test/infra/power-status.test.ts`, `test/relay/run-timeline.test.ts`, `test/relay/stream-session.test.ts`, `test/quota/reply-quota-report.test.ts`, `test/index.test.ts`.
- Previous delivery: [delivery.1.7.1.md](./delivery.1.7.1.md).
- User-facing behavior: [README.md](../../README.md), [README-zh.md](../../README-zh.md).
