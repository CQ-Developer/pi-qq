# pi-qq delivery 1.6.2

> **Delivery record.** 1.6.2 makes `/last` repush the current run snapshot, hardens stream recovery, removes `replyType: "last"`, and consolidates the code-review and repair notes. See [README](../../README.md) for current user-facing behavior.
> Version: 1.6.2
> Date: 2026-11-11
> Previous: [delivery.1.6.1.md](./delivery.1.6.1.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

Before 1.6.2, `/last` during a run only repushed `run.currentText`. If the run was still producing thinking or tools, the command silently did nothing. A separate long-run defect also stopped all relay output when QQ returned `40054005` (duplicate `msgseq`).

1.6.2 covers:

- `/last` snapshot repush for `replyType: "full"`;
- separation of run content state from stream delivery;
- removal of `replyType: "last"`;
- rate-limit retry correctness;
- fresh-stream recovery for duplicate `msgseq`;
- English-only log messages;
- dead-code and duplication cleanup from the full code review;
- direct tests for the new timeline and writer boundaries.

Out of scope:

- replaying the complete run history;
- changing model/agent behavior or tool set;
- adding tool partial-output forwarding;
- docs packaging changes and optional large refactors listed in section 8.

## 2. Observed failure

The 2026-11-11 log contained a 26-minute run that reached 221 stream bubbles. At 12:55:19 local time the next stream used a previously used `msg_seq`:

```text
40054005 消息被去重，请检查请求msgseq
```

The same checkpoint `msgSeq` was retried twice, all retries were rejected, and `BubbleWriter` killed the stream. After that:

- 146 subsequent tool starts produced no relay output;
- `/last` at 13:01:44 and 13:04:21 logged `last repush ignored` with `textLength=0`;
- the first assistant text appeared at 13:09:56, after both `/last` calls;
- the final text used the normal plain-message fallback.

The `/last` calls did not fail because the text was too old; at that moment there was no `currentText` at all. The run state and the delivery writer were coupled, so `/last` could not use the thinking/tool state.

## 3. Final decisions

| #   | Question                                               | Decision                                                                                                 |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| D1  | What should `/last` push during a full-mode run?       | The current thinking, the active/recent tools, and the current text, without waiting for assistant text. |
| D2  | How much history should `/last` replay?                | A bounded state snapshot: current active tool plus the last three finished tools, capped at five.        |
| D3  | Should run state depend on the writer?                 | No. `RunTimeline` owns content and tool lifecycle; `RunFeedback` decides delivery.                       |
| D4  | What should happen on `40054005`?                      | Open a new stream with a fresh `msgSeq`, replay the failed buffer, and keep the existing recovery cap.   |
| D5  | Should `replyType: "last"` remain?                     | No. Keep only `full` and `simple`; old `"last"` values fall back to `full` with a validation warning.    |
| D6  | Should log files follow `language`?                    | No. Log messages are written directly in English; `language` only affects UI notifications and replies.  |
| D7  | Should `/last` fail silently when there is no content? | No. Reply with `commands.last.empty`.                                                                    |

## 4. `/last` snapshot

`repushCurrent()` now builds a `RepushResult` instead of returning a bare boolean:

```ts
type RepushResult =
  | { ok: true; thinkingLength: number; toolCount: number; textLength: number }
  | { ok: false; reason: "no-run" | "empty" };
```

Full-mode snapshot order:

1. current thinking;
2. current active tool and recent finished tools in start order;
3. current assistant text.

`BubbleWriter.restartSnapshot()` accepts structured blocks and:

- closes an open code fence;
- rotates the old stream;
- updates the target `openid` / `msgId`;
- resets `streamDead`, pending resume, block and fence state;
- pushes thinking/tool/text blocks to the new stream.

`simple` mode uses a text-only snapshot. `last` mode no longer exists.

After a repush:

- `thinkingSentLen` / `resultSentLen` are not reset; they continue tracking processed content;
- deferred thinking/text are cleared because the snapshot already includes them;
- an active tool result and subsequent assistant deltas continue on the new stream.

## 5. Stream reliability

### 5.1 Rate-limit retries

`AppendStream.sendWithRetry()` now:

- advances `index` before a rate-limit retry, matching `qqbot-nodejs`'s `StreamSession`;
- recognizes `status`, `httpStatus`, `code`, `err_code`, `bizCode`, and message text for 429/50002.

### 5.2 Duplicate `msgseq`

`BubbleWriter.handleStreamError()` detects `40054005` / duplicate-`msgseq` messages. Instead of resuming the same checkpoint, it opens a fresh stream with:

- no old `msgSeq` (the new stream generates one);
- `index: 0`;
- the failed buffer preserved.

Other stream errors keep the existing resume semantics. The recovery-attempt cap still applies.

## 6. Implementation

| File                                  | Change                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/relay/run-timeline.ts` (new)     | `RunTimeline`, tool state, snapshot selection, diagnostics                                    |
| `src/relay/run-stream-relay.ts`       | Uses `RunTimeline`; `advanceTools()`; `RepushResult`; removes last-mode delivery and fallback |
| `src/relay/bubble-writer.ts`          | `RepushBlock`, `restartSnapshot()`, fresh-stream recovery, options-based push API             |
| `src/relay/stream-session.ts`         | Rate-limit index advance, API status fields, optional fresh `msgSeq` resume                   |
| `src/relay/reply-policy.ts`           | Removes `relayTextLive`, `deliverLastAtEnd`, and last policy                                  |
| `src/infra/reply-type.ts`             | Only `full` and `simple`                                                                      |
| `src/qq/inbound-command.ts`           | `/last` consumes `InboundPushResult`; empty snapshot notice                                   |
| `src/qq/media-tool.ts`                | Shared send/result helper; removes test-only `isActive`                                       |
| `src/infra/file-logger.ts`            | Writes direct English messages; `msgKey` lookup only                                          |
| `src/infra/log-message-keys.ts` (new) | Stable English message-to-key map                                                             |
| `src/infra/i18n.ts`                   | UI strings only; log translations and localization removed                                    |

## 7. Verification

Automated:

- **234 tests** across 22 files.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm pack --dry-run` pass.
- New tests cover:
  - thinking-only and tool-only `/last` snapshots;
  - snapshot ordering and the tool window;
  - writer-dead recovery;
  - continuation of tool results after repush;
  - `40054005` fresh-stream recovery;
  - rate-limit index and `httpStatus` / `bizCode` detection;
  - direct `restartSnapshot()` behavior.

Manual QQ smoke test (`pi-qq-2026-11-11.log`, local time 18:11–18:17):

- four runs covering `simple` and `full`;
- `/last` in full mode repushed 366 characters of current thinking and two tools with a new `msgId`;
- `/status` returned the expected full-mode report;
- `/stop` ended both active runs;
- no warnings, stream errors, `40054005`, or rate-limit events.

Not manually exercised:

- actual rate-limit retry;
- actual `40054005` recovery;
- `/last` with a dead writer;
- `/last` in `simple` mode.

These paths are covered by automated tests.

## 8. Code review consolidation

Fixed from the review:

- rate-limit retry index and API error fields;
- duplicate-`msgseq` recovery;
- unused relay/command surface and dead translations;
- duplicated media send/result construction and text-delta handling;
- command-layer dependency on the relay `RepushResult` type;
- unnecessary `index` option in attachment saves;
- empty attachment responses;
- English-only log messages.

Deferred intentionally:

- npm package docs policy (`doc/todo.md` and archive docs) is left to the release owner;
- splitting `index.ts`, `BubbleWriter`, or the large `run-stream-relay` test file further;
- a broader `ReplyType` policy refactor beyond the two remaining modes.

No dependency cycles were found.

## 9. Risks and limitations

| Risk                                                         | Impact                                             | Handling                                                    |
| ------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| Snapshot order differs from the original interleaving        | Repush is a state snapshot, not a full transcript  | Documented behavior                                         |
| Tool window is bounded                                       | Older tools are omitted                            | Active tool + last three finished tools                     |
| A duplicate-`msgseq` repush can create a new bubble          | The old bubble remains                             | Only triggered by a stream failure; history is not replayed |
| `replyType: "last"` removal is breaking for configured users | Values fall back to full with a warning            | Documented in the READMEs and changelog                     |
| Log language no longer follows `language`                    | Existing users may expect localized logs           | Logs are stable English; UI remains localized               |
| `doc/` contents are still in the current package manifest    | Internal notes may ship until packaging is changed | Deferred to the release owner                               |

## 10. References

- User-facing behavior: [README.md](../../README.md), [README-zh.md](../../README-zh.md).
- Previous delivery: [delivery.1.6.1.md](./delivery.1.6.1.md).
- Manual test log: `/home/chen/project/mine/pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-11.log`.
- This record replaces the temporary `doc/repair.md` and code-review working notes.
