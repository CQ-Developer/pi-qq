# pi-qq delivery 1.7.3

> **Delivery record.** 1.7.3 fixes a debug-log body leak, recovers ended stream sessions (`40034019`), reduces event-loop log volume, and logs command replies outside runs. See [README](../../README.md) for current user-facing behavior.
> Version: 1.7.3
> Date: 2026-11-28
> Previous: [delivery.1.7.2.md](./delivery.1.7.2.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

1.7.3 is driven by the 2026-11-24–27 real logs (138,137 lines / 32 MiB, 48 runs, 12.2 active hours):

- SDK `Dispatch event` lines still included full inbound message text, message IDs, and avatar URLs.
- `40054005` (`消息被去重`) was followed by `40034019` (`流式引导已经结束`) in 7 of 9 cases; the writer resumed the same `stream_msg_id`, exhausted retries, and 4 runs lost streaming delivery.
- Event-loop diagnostics produced 8,805 lines / 1.72 MiB (2.7–6.0% of the log) at a 5 s cadence without actionable spikes.
- Idle command replies such as `/status` had no `outbound` log because the scope was gated to active runs.

Out of scope:

- QQ client rendering of very long bash commands. The 21,896-character command was sent in 6 content frames plus DONE without `40034017`; the user confirmed the client displays it normally.
- `msg_id` validity beyond one hour, lifecycle differences by account/region/client, and `40034020` recovery under real network jitter or rate limiting.
- The root cause of duplicate `msg_seq` (`40054005`); this release only makes the resulting `40034019` recoverable.
- Stream framing, rotation policy, the QQ protocol, or the SDK.

## 2. Findings

### 2.1 Dispatch payload leak

`src/infra/file-logger.ts` summarized only `Body: ` lines. SDK gateway lines of the form
`[id] Dispatch event: t=C2C_MESSAGE_CREATE payload={...}` kept the complete payload. The reviewed logs contained 8 such lines; 2 were real user text.

### 2.2 `40054005` followed by `40034019`

The logs contained 9 duplicate-`msgseq` errors. In 7 cases a fresh stream was opened successfully, but a later frame returned `40034019` (`流式引导已经结束，不能继续发送`). `BubbleWriter.handleStreamError()` treated it as retryable, resumed the same dead `stream_msg_id`, and after two retries called `killStream()`. 4 runs ended with `delivered=false`; final text could still fall back to a normal message, but streamed tool output was lost.

### 2.3 Log volume

| Scope / metric    | Value      |
| ----------------- | ---------- |
| Event-loop lines  | 8,805      |
| Event-loop size   | 1.72 MiB   |
| Share of log size | 2.7–6.0%   |
| `maxMs` p50       | 21–23 ms   |
| `maxMs` > 100 ms  | 16 samples |
| `maxMs` > 500 ms  | 0          |
| `driftMs`         | max 139 ms |

The event-loop was no longer the dominant scope in long logs (`qqbot` 37%, `stream` 25%, `run` 23%), but its absolute volume was still easy to reduce.

### 2.4 Idle command replies

Of 3 `/status` commands, the 2 sent during an active run had `outbound` and SDK request logs; the idle `/status` at 2026-11-27 04:42:41Z had only the inbound command record. Command replies are metadata-only and safe to log outside runs.

### 2.5 Long command rendering

A bash call with `argsLength=21,896` was relayed as a fenced block with the `bash` language tag: 6 content frames (about 3.5 KB each) plus DONE, all HTTP 200, no `40034017`. The QQ client displayed it normally; no A/B variants were needed.

## 3. Decisions

| #   | Question                                        | Decision                                                                                                                                       |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How are SDK dispatch payloads logged?           | Keep the event type and `[id]` prefix; replace `payload=` with `payload=<N chars>`. Only `Dispatch event:` lines are summarized.               |
| D2  | How is `40034019` handled?                      | Treat it as a terminated stream: drop `stream_msg_id` and `msg_seq`, open a fresh stream with `index=0`, and replay the unacknowledged buffer. |
| D3  | Does `40034019` trigger auto-rebind?            | No. Auto-rebind remains limited to `40034020`; `40034019` uses fresh-stream recovery and then the existing `/last` / normal-text fallback.     |
| D4  | What is the event-loop cadence?                 | Fixed 30 s sampling. Threshold-only logging was rejected because it loses the baseline.                                                        |
| D5  | Is `outbound` gated by a run?                   | No. After login, `outbound` records metadata outside runs. `qqbot` SDK request logs remain gated to active runs.                               |
| D6  | How is the new stream error classified in logs? | Add `ended` for `40034019`; keep `expired` for `40034020` and `resetSeq` for `40054005`.                                                       |
| D7  | Is the duplicate-`msgseq` root cause fixed?     | No. Recovery is defensive; the cause of `40054005` remains open.                                                                               |

## 4. Implementation

| Area             | Files                                                                                                   | Change                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Dispatch logging | `src/infra/file-logger.ts`, `test/infra/file-logger.test.ts`                                            | Summarize `Dispatch event` payloads; tests for content, empty payload, and non-dispatch `payload=` text.              |
| Stream recovery  | `src/relay/bubble-writer.ts`, `test/relay/bubble-writer.test.ts`, `test/relay/run-stream-relay.test.ts` | Add `isEndedStreamError()`; fresh-stream recovery for `40034019`; log `ended`; tests for recovery and no auto-rebind. |
| Event loop       | `index.ts`                                                                                              | `EVENT_LOOP_INTERVAL_MS = 30_000`; interval and drift use the same constant.                                          |
| Outbound logging | `index.ts`, `test/index.test.ts`                                                                        | Allow `outbound` after login; test that it logs outside a run while `stream` remains gated.                           |
| Release metadata | `CHANGELOG.md`, `package.json`, `package-lock.json`                                                     | Move the changes to 1.7.3.                                                                                            |

## 5. Verification

### 5.1 Automated

- 25 test files, **266 tests passed**.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm pack --dry-run` pass.
- New coverage: dispatch payload summary, empty dispatch payload, non-dispatch payload text, `40034019` fresh-stream recovery, no auto-rebind for `40034019`, and outbound logging outside a run.

### 5.2 Real QQ

Environment: Linux; pi 1.6.1; Node.js 26.13.1; local 1.7.2 code plus these fixes; one C2C account. Times are UTC.

| Case                            | Result                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login / ping                    | Bot connected; `ping` replied through a stream, `delivered=true` (4.0 s run).                                                                                                                                 |
| Idle `/status`                  | `outbound` recorded `targetId`, `msgId`, and `length=186`; no reply text.                                                                                                                                     |
| 120 s run with steering message | Marker text appeared **0** times in the log; the dispatch line was `payload=<709 chars>`. Run `delivered=true`.                                                                                               |
| Event loop                      | 5 samples at 30 s intervals; `driftMs` between -1 and 1.                                                                                                                                                      |
| Single `40034019`               | `ended=true` at checkpoint `index=2`, `stream_msg_id` present, buffer 841 chars. New stream: `index=0`, no `stream_msg_id`, buffer 841. All following requests 200; `delivered=true`; final text 4,898 chars. |
| Three `40034019` injections     | Three `ended` errors with `resumeAttempts` 0/1/2, then `stream unavailable` (code 40034019), `delivered=false`. Final text was sent as normal messages in 4,498 + 400 char chunks and received.               |

### 5.3 Test environment

The temporary test project was `/home/chen/project/mine/pi-qq-test`:

- `.pi/settings.json` loaded the local package `../../pi-qq`.
- `.pi/extensions/stream-probe.ts` patched `MessageApi.prototype.sendC2CStreamMessage` in the test process. It could arm one or more `40034019` errors on a content frame that already had a `stream_msg_id`.
- Logs were written under `.pi/pi-qq/logs/test-run-1/`.

The probe extension is test-only and is not part of the package.

## 6. Risks and limitations

| Risk                                                     | Impact                                                 | Handling                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `40034019` is `msg_id`-level on another platform version | A fresh stream can also fail                           | Retries remain bounded; the writer falls back to `/last` or a normal message.                            |
| `40054005` root cause unknown                            | Duplicate `msg_seq` can still interrupt a stream       | `40034019` recovery now makes it survivable; recovery logs expose the pattern.                           |
| `msg_id` beyond one hour                                 | Unverified                                             | Long-term observation; the longest verified fresh stream was at 54.3 min.                                |
| `40034020` under real jitter/rate limit                  | Unverified                                             | Recovery uses the verified fresh-stream path; no rate-limit case was observed.                           |
| Full IDs in debug logs                                   | `senderId`, `openid`, and `appId` remain in local logs | Logs are debug-only and local; treat them as sensitive. Dispatch bodies are no longer logged.            |
| 30 s event-loop sampling                                 | Fewer baseline points                                  | `maxMs` still covers the whole interval; use a temporary 5 s override when investigating a spike.        |
| One account / region / client                            | Results do not prove platform-wide behavior            | Keep recovery defensive and observe real logs.                                                           |
| Fallback reports `delivered=false`                       | Streaming delivery failed even though text arrived     | `run ended` records `delivered` for the stream; normal-text fallback is logged separately in `outbound`. |

## 7. Open items

Active work is tracked in [doc/todo.md](../todo.md):

- `msg_id` validity beyond one hour.
- `40034020` recovery under real network jitter, reconnects, and rate limiting.
- The cause of duplicate `msg_seq` (`40054005`).

## 8. References

- Stream endpoint: `https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html`
- Error codes: `https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html`
- Code: `src/infra/file-logger.ts`, `src/relay/bubble-writer.ts`, `index.ts`.
- Tests: `test/infra/file-logger.test.ts`, `test/relay/bubble-writer.test.ts`, `test/relay/run-stream-relay.test.ts`, `test/index.test.ts`.
