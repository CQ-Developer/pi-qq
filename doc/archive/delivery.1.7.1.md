# pi-qq delivery 1.7.1

> **Delivery record.** 1.7.1 hardens the QQ stream relay against oversized and expired streams, makes `/stop` non-blocking, and reduces debug logs to runtime metadata. See [README](../../README.md) for current user-facing behavior.
> Version: 1.7.1
> Date: 2026-11-18
> Previous: [delivery.1.7.0.md](./delivery.1.7.0.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

1.7.0 introduced a monotonic `msg_seq` allocator. 1.7.1 addresses three production failures found in long QQ runs:

- `40034017`: a markdown frame exceeded the platform shard limit.
- `40034020`: a stream exceeded its total lifetime during a long tool; the relay kept resuming a dead `stream_msg_id` and lost tool output.
- `/stop`: a tool that ignores abort kept `/stop` waiting for the tool/run to end.

The release also:

- records extension runtime metadata instead of message text, tool arguments/results, assistant text, and SDK bodies;
- logs the inbound trigger before a run becomes active;
- aggregates `append: while flushing` diagnostics;
- skips typing while a stream is active.

Out of scope:

- a default watchdog or stream rotation;
- changing QQ protocol limits or the SDK;
- full ID masking (debug logs retain IDs for correlation; see section 7);
- protocol reductions for trailing newline frames and the first text frame (see sections 7 and 8).

## 2. Observed failures

The original 18 MB log (18,406 lines) is no longer retained; the key frames are summarized here.

### 2.1 Expired stream during a long tool

- 12:25:13: `seq=237`, first frame 442 chars, tool header `docker compose ... up -d --build`; the build ran for 23m28s.
- 12:48:40: the next frame returned `40034020` (`同一流式消息发送超过时间限制`).
- Two resumes with the same `stream_msg_id` failed; the writer went dead.
- 36 tools completed while the stream was dead; `/last` replayed only the most recent 3 finished tools, so 33 results never appeared.

### 2.2 Oversized frame

- 13:21:36: successful frame 3,706 chars / 3,743 B.
- 13:23:37: `seq=30` first frame 4,672 chars / 4,719 B returned `40034017` (`流式消息md分片需要\n结束`).
- Resumes grew the buffer to 5,044 / 5,145 B and 5,062 / 5,170 B, still `40034017`; the stream went dead.
- 9 read tools completed in the dead window; 3 were replayed by `/last`, 6 were not.

### 2.3 `/stop` blocking

- A 300 s tool that ignored abort kept `/stop` waiting for about 2m57s.
- An abortable 300 s tool returned `aborted` after about 61 s.
- The blocking path was the cause; the fixed behavior is described in section 5.

### 2.4 Integrity and event loop

- Run-end `currentTextLen` was 2,202 / 1,831, matching the stream-reconstructed text; no final answer was lost.
- Event-loop max delay was 618 ms; no seconds-level stall was involved.
- The log had no `40054005`; per-message `msg_seq` allocation was already effective.

## 3. Investigation conclusions

Hypotheses tested against the official pages and the real QQ experiments:

| #   | Hypothesis                                                 | Evidence                                                                                                | Verdict                                                                    |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| H1  | The platform uses an idle timeout for one stream.          | `idle 2` and `idle 5` pass, but `heartbeat 10/1` still fails at about 600 s.                            | Refuted as the primary limit; the 600 s total lifetime explains `idle 10`. |
| H2  | The platform uses a total lifetime limit.                  | `heartbeat 10/1` succeeds 9 times but still fails at about 600 s; `idle 10` fails at the same boundary. | Confirmed; about 600 s total.                                              |
| H3  | Long silence lets the server clean up the `stream_msg_id`. | Resuming the same `stream_msg_id` fails after the limit; a fresh stream succeeds.                       | Consistent; recovery must open a new stream.                               |
| H4  | The inbound `msg_id` expires independently.                | A new stream with the same `msg_id` works at 20 min; the original log created one after about 22 min.   | Not a blocker within the tested window; 1 h not verified.                  |
| H5  | `40034017` is a single-frame shard limit.                  | Successful frames stayed below 3,743 B; failures started at 4,719 B; a 3,500 B split passes on real QQ. | Confirmed; 3,500 B is the chosen safe limit.                               |

Official documentation:

- The stream endpoint lists 50 QPS and only public error codes; it does not document `40034020`, `40034017`, `40034128`, heartbeats, or a 30-minute limit.
- `is_wakeup=true` skips `msg_id` / `event_id` validation, but it is a recall-message semantic, not a general long-task continuation mechanism.
- External material claiming a 30-minute limit was not used; it was unsupported or referred to another platform.

## 4. Final decisions

| #   | Question                               | Decision                                                                                                                                                                                   |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | How are oversized frames handled?      | Limit a frame to 3,500 B; split at the last `\n`; hard-cut a single long line and append `\n`.                                                                                             |
| D2  | What is the stream lifetime?           | About 600 s total; heartbeats do not extend it; the boundary fluctuates by about 1 s.                                                                                                      |
| D3  | What happens on `40034020`?            | Open a fresh stream: new `msg_seq`, `index=0`, no old `stream_msg_id`; keep the unacknowledged buffer.                                                                                     |
| D4  | What is the recovery order?            | Same `msg_id` fresh stream first; auto-rebind to the current target or a recent inbound target (within 5 minutes) as fallback (at most once per run); `/last` remains the manual fallback. |
| D5  | Should a watchdog be added?            | Not by default. Five- and eight-minute rotations work; use eight minutes if a rotation option is added later.                                                                              |
| D6  | How does `/stop` behave?               | Abort, reply immediately, and keep `waitForEnd()` as background logging only.                                                                                                              |
| D7  | What do debug logs contain?            | Runtime metadata only: event, time, IDs, lengths, counts, durations, status, error codes, and stream indexes. No message text, tool arguments/results, assistant text, or SDK bodies.      |
| D8  | Are IDs masked?                        | No. `messageId`, `senderId`, `openid`, and `appId` remain in debug logs for correlation; logs are local and must be treated as sensitive. Masking remains an open decision.                |
| D9  | Should typing run during a stream?     | No. Typing is skipped while a stream is active.                                                                                                                                            |
| D10 | How are `while flushing` logs limited? | Log the first append and every 50th append per flush.                                                                                                                                      |
| D11 | How long is `msg_id` valid?            | A fresh stream with the same `msg_id` works 20 minutes after inbound; one hour is not verified.                                                                                            |

## 5. Implementation

| Area           | Files                                                                                                                | Change                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame sizing   | `src/relay/stream-session.ts`                                                                                        | `MAX_FRAME_BYTES = 3500`; UTF-8 byte-aware `takeFrame()`; newline-preferred split; hard cut with trailing `\n`; flush/done loops with 300 ms minimum spacing.                                                                                         |
| Expired stream | `src/relay/bubble-writer.ts`                                                                                         | Treat `40034020` and `40054005` as non-resumable; open a fresh stream with a new `msg_seq` and `index=0`; replay the unacknowledged buffer; expose `hasActiveStream`.                                                                                 |
| Auto-rebind    | `src/relay/run-stream-relay.ts`                                                                                      | After a `40034020`, rebind to the current target or a recent inbound target (within 5 minutes), replay thinking, the last three finished tools plus any active tool (five tools at most), and the current text; at most one automatic rebind per run. |
| `/stop`        | `src/qq/inbound-command.ts`                                                                                          | Call `ctx.abort()` and reply immediately; `waitForEnd()` only writes background diagnostics.                                                                                                                                                          |
| Debug logging  | `src/infra/file-logger.ts`, `index.ts`, `src/qq/qq-bot.ts`, `src/qq/qq-message-handler.ts`, `src/qq/reply-sender.ts` | Scope-aware log gate; inbound allowed after login; SDK bodies reduced to `<N chars>`; `logValueLength()` for arguments/results; metadata fields on inbound, tool, and assistant events.                                                               |
| Typing         | `src/relay/run-stream-relay.ts`                                                                                      | Skip typing while `BubbleWriter.hasActiveStream` is true.                                                                                                                                                                                             |
| `msg_seq`      | `src/relay/msg-seq.ts`                                                                                               | Monotonic per-`msgId` allocator introduced in 1.7.0; still used for streams, passive text, media, and diagnostics.                                                                                                                                    |

Behavioral notes:

- A new stream keeps the old `msg_id` and `event_id`; only `stream_msg_id`, `msg_seq`, and `index` restart.
- `40034020` after a long idle is recovered by the same path; `is_wakeup=true` and a fresh inbound target also work.
- Credential redaction remains a fallback for error text and a small set of fields; the primary guarantee is that message content is not logged.
- The relay still rotates bubbles at tool and thinking boundaries; this is unchanged from 1.7.0.

## 6. Verification

### 6.1 Automated

- 24 test files, **251 tests passed**.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm pack --dry-run` pass.
- Coverage includes oversized and no-newline frames, `40034020` fresh-stream replay, auto-rebind, `/stop` with a run that never ends, log gating, SDK body summarization, and tool logs without arguments/results.

### 6.2 Real QQ stream experiments

Environment: Linux; pi 1.5.2; Node.js 24.22.0; single C2C user; local pi-qq 1.7.0 plus these fixes. The temporary experiment extension, scripts, and logs were removed after testing.

All times below are UTC+8. The experiment hook is not part of the release.

| Case                  | Key duration        | Result                                                                                 |
| --------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `idle 2`              | 120.0 s idle        | Probe and DONE succeed                                                                 |
| `idle 5`              | 300.0 s idle        | Probe and DONE succeed                                                                 |
| `idle 10`             | 600.0 s idle        | Probe returns `40034020`                                                               |
| `heartbeat 10/1`      | 10th at about 600 s | First 9 succeed; 10th returns `40034020`; heartbeats do not extend the lifetime        |
| `rotate 5`            | 300 s               | Old stream DONE succeeds; same `msg_id` new stream succeeds (`msg_seq=2`)              |
| `rotate 8`            | 480 s               | Same as `rotate 5`; about 2 minutes below the limit                                    |
| `expire 10`           | 600 s               | Old stream `40034020`; same `msg_id` new stream succeeds; 604.5 s total                |
| `expire 20`           | 1,200 s             | Old stream `40034020`; same `msg_id` new stream succeeds; 1,203.5 s total              |
| `expire-full 10`      | 600 / 601 s         | Same `msg_id`, `is_wakeup=true`, and fresh inbound target all succeed; 605.6 s total   |
| `large 5`             | 5,568 chars         | Split 3,371 + 2,197 chars; both 200; 2.8 s; no `40034017`                              |
| `large-line 5`        | 5,121 B, no breaks  | Hard split 3,500 + 1,622 B; both 200; 2.6 s; no `40034017`                             |
| `relay 10.5`          | 10.5 min            | Old stream `40034020`; new stream and DONE succeed; `streamTookOver=true`              |
| `budget 6` / `10`     | 6.7 / 10.6 s        | 6 / 10 plain texts all succeed; no `40034128`                                          |
| `LONG_TOOL_LONG_TEST` | 720 s               | Old stream `40034020`; fresh stream delivers tool result and final text; 725.5 s total |

Key conclusions:

- The stream lifetime is about 600 s from creation, not an idle window; the boundary jitters by about 1 s.
- A fresh stream with the same `msg_id` works after 10 and 20 minutes; `is_wakeup=true` and a fresh inbound target also work.
- The fresh-stream `40034020` path was verified through the real `RunFeedback` / `BubbleWriter` path and a 12-minute agent tool.
- Frame splitting works for both newline-containing and single-line oversized content.

### 6.3 `/stop` and steering

- A 300 s tool that ignores abort: `/stop` waited about 2m57s before the fix; after the fix the reply was sent in about 1 ms while the tool kept running.
- An abortable 300 s tool: returned `aborted` after about 61 s.
- Steering is delivered after the tool batch ends, not during execution.
- `ctx.abort()` causes pi to restore queued steering messages to the editor; this is TUI behavior, not lost input.

### 6.4 Logging verification

Before the fix (v1.7.0, 2026-11-17 real usage log): 906 KiB in 15 minutes, 4 runs, 24 tools, 175 stream frames. The log contained 37,309 chars of streamed content (thinking 27,154, tool markdown 9,294, final answers 861), full tool arguments (6.6K chars) and results (30K chars, capped at 2,000 per entry), assistant `textPreview`, and full SDK bodies. It had 1,478 `append: while flushing` lines / 190 KiB and no inbound/outbound records.

After the fix (main build, 2026-11-18): 1 run, 4.3 s, 1 `bash` call, 22-char inbound, 62-char final answer. The log is 80 lines / 21.5 KiB; all 7 requests returned 200.

Checks that passed:

- SDK bodies are only `Body: <N chars>`; no `content_raw`, `content`, `text`, or request-body JSON.
- `tool start` has only `argsLength` (20); `tool end` has only `resultLength` (417); `tool update` has `partialLength` (14); no arguments or results.
- Assistant events have `textLength` (0 / 62); no `textPreview`.
- `inbound` has `contentLength`, `attachmentCount`, and `msgType`; `sent to pi` has `textLength`; neither contains the message body.
- No `>>> Body: {`, `"args"`, `"result"`, `"firstPartial"`, `"partial"`, or `"textPreview"` appears in the log.

Limits of this verification:

- `append: while flushing` was not exercised by the short run; `test/relay/stream-session.test.ts` covers the aggregation.
- Full message and user IDs are still logged (see section 7).

## 7. Risks and limitations

| Risk                                | Impact                                                                                             | Handling                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 600 s boundary jitter               | A frame sent at the boundary can still fail once before recovery                                   | Do not schedule rotation at the limit; leave margin; the fresh-stream path recovers the next frame |
| `msg_id` validity beyond 20 minutes | One-hour-old inbound messages are unverified                                                       | Long-term observation                                                                              |
| Platform variability                | Lifetime, error mapping, and rendering may differ by account, region, or client                    | Keep recovery defensive; collect real logs                                                         |
| Typing timeout                      | A 10 s typing timeout was seen in earlier logs but not reproduced                                  | Typing is skipped while a stream is active; the timeout path remains unverified                    |
| Full IDs in debug logs              | `messageId`, `senderId`, `openid`, and `appId` remain in local logs                                | Logs are debug-only and local; treat as sensitive; masking is an open decision                     |
| Log volume                          | `run` diagnostics repeat the tool list on every event; stream timing records are verbose           | Metadata only; no content. Compaction is an open optimization                                      |
| Trailing newline frames             | A lone `\n` can be sent before a bubble's DONE, adding a request and latency                       | Known; needs a protocol test before merging the newline into DONE                                  |
| First text frame                    | A new text bubble can show 1–4 characters before the rest arrives                                  | Known; needs a flush policy for text deltas while keeping tool headers immediate                   |
| `run ended` ordering                | The run-end log precedes the final `flush` / `done`                                                | Known; does not affect delivery, but the log cannot prove the last frame succeeded                 |
| `lastFlushAt = 0`                   | The first `append: immediate` in a new stream logs an epoch-sized `elapsed` value                  | Log-only noise                                                                                     |
| Passive reply budget                | The platform accepted 10 probes, but the local limit remains 4; each media send consumes one reply | Keep the conservative local limit; stream bubbles are not counted the same way                     |
| Auto-rebind limit                   | At most one automatic rebind per run                                                               | `/last` remains the manual fallback                                                                |
| Watchdog not implemented            | A long stream can still hit `40034020` once before recovery                                        | The recovery path is verified; an optional eight-minute rotation can be added later                |
| Real QQ coverage                    | One account, one region, one network, single-user C2C                                              | Results are strong for this setup, not a platform guarantee                                        |

## 8. Open items

Active work is tracked in [doc/todo.md](../todo.md):

- confirm how the QQ client renders long `bash` tool start lines;
- observe stream lifetime and `msg_id` validity beyond 20 minutes and one hour;
- reproduce the typing timeout and decide whether client isolation is needed;
- decide whether to mask IDs in debug logs;
- compact `run` diagnostics and stream timing logs;
- evaluate merging the trailing `\n` into the DONE frame and throttling the first text delta.

## 9. References

- Stream endpoint: `https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html`
- Error codes: `https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html`
- Code: `src/relay/stream-session.ts`, `src/relay/bubble-writer.ts`, `src/relay/run-stream-relay.ts`, `src/relay/msg-seq.ts`, `src/qq/inbound-command.ts`, `src/infra/file-logger.ts`.
- Tests: `test/relay/stream-session.test.ts`, `test/relay/bubble-writer.test.ts`, `test/relay/run-stream-relay.test.ts`, `test/qq/qq-message-handler.test.ts`, `test/infra/file-logger.test.ts`, `test/index.test.ts`.
- Previous delivery: [delivery.1.7.0.md](./delivery.1.7.0.md).
- User-facing behavior: [README.md](../../README.md), [README-zh.md](../../README-zh.md).
