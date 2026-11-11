# pi-qq delivery-v6

> **Delivery record.** v6 adds the `replyType` setting to control how much of an agent run is pushed to QQ, and fixes the 12k bubble split that almost never fired. See [README](../../README.md) for current user-facing behavior.
> Version: 1.6.0
> Date: 2026-11-09
> Previous: [delivery.2026.10.29.md](./delivery.2026.10.29.md), [delivery.2026.10.30.md](./delivery.2026.10.30.md), [delivery.2026.11.03.md](./delivery.2026.11.03.md), [delivery.2026.11.04.md](./delivery.2026.11.04.md), [delivery.2026.11.05.md](./delivery.2026.11.05.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

Before v6, pi-qq pushed everything the agent produced into QQ: thinking blocks, tool start lines, tool results, skill blocks, and every assistant message. A 29-minute run produced 184 bubbles (see [doc/todo.md](../todo.md)), so the actual answer was buried in tool noise.

v6 gives that choice a name and a setting:

- a new `replyType` setting with three modes: `full` (current behaviour), `simple`, `last`;
- `full` stays the default, so upgrading changes nothing;
- `/last` during a running task no longer repushes partial output in `last` mode;
- `/qq-status` shows the effective mode;
- an unrelated existing defect is fixed: the 12k bubble split almost never fired.

In scope:

- `replyType` parsing, validation, and defaulting;
- per-mode relay behaviour in `RunFeedback`;
- `last` mode delivery at the end of a run, with plain-message fallback;
- the `/last` command change in `last` mode;
- the reply type in `/qq-status`;
- the 12k bubble split fix.

Out of scope:

- summarising, trimming, or rewriting model output;
- changing pi's agent behaviour, prompts, or tool set;
- per-command or per-session mode switching;
- changing `qq_send_media` behaviour (media files are still delivered in every mode);
- a "progress hint" while a `last` run is in flight.

## 2. Final decisions

| #   | Question                                                            | Decision                                                                                                                               |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Should `last` send a progress hint while the task runs?             | No. It contradicts "only the last message"; the typing indicator already covers the wait. A hint would be its own setting, not a mode. |
| D2  | Should `simple` offer a "merge adjacent assistant messages" switch? | No. One assistant message is one bubble; the boundary already comes from `closeBlock()`.                                               |
| D3  | Should QQ commands switch the mode at runtime (e.g. `/mode last`)?  | No. Two sources of truth would compete with `deliverAs` and the other settings.                                                        |
| D4  | How is Markdown handled for the `last` message?                     | Keep the existing split: the stream channel sends raw Markdown, the plain-message fallback runs `markdownToPlain()`.                   |
| D5  | Should `/qq-status` show the reply type?                            | Yes. One `💬 Reply type: <mode>` line, so the effective setting is verifiable.                                                         |
| D6  | What should `/last` do during a running task in `last` mode?        | Do not repush. Reply with a localized notice (`commands.last.running`) instead: whatever is on screen cannot be the last message.      |
| D7  | When is the setting read?                                           | Per session. `activeSettings` is refreshed on `session_start` and `/qq-login`; the config file is never read on the hot path.          |
| D8  | Should `last` still deliver after `/stop` aborts the run?           | Yes. `agent_end` also fires on abort, and a conclusion the agent already reached should not be lost.                                   |

## 3. The three modes

| Dimension                  | `full`                              | `simple`                  | `last`                             |
| -------------------------- | ----------------------------------- | ------------------------- | ---------------------------------- |
| Thinking blocks            | per `thinkingRelay`                 | no                        | no                                 |
| Tool start lines / results | yes                                 | no                        | no                                 |
| Assistant text             | all, streamed live                  | all, streamed live        | last one only                      |
| When the text reaches QQ   | while generated                     | while generated           | when the run ends                  |
| Bubbles per run            | one per block switch (often dozens) | one per assistant message | 1 (or 1 plain message on fallback) |
| Model error message        | immediately, as a plain message     | same                      | same                               |

- `full` is the default and reproduces pi-qq 1.5.x exactly.
- `simple` streams every assistant message live, one QQ bubble per message. Text produced while a tool is still running is pushed immediately instead of being deferred until the tool batch ends (there is no tool bubble to keep it clear of).
- `last` sends nothing while the task runs. When the run ends, the last assistant message that has text is delivered as one bubble (stream first, plain message on failure).
- "Last" means the last assistant message **with text**. A trailing message that only carries a tool call falls back to the previous one with text.
- A model error is always delivered immediately as a plain message, in every mode, and never occupies the "last message" slot.
- Tool output is never relayed in `simple` or `last`, but files sent with `qq_send_media` still arrive.

Example run:

```text
user     : 帮我看下 README 里的安装步骤对不对

agent    : thinking  用户问的是安装步骤，先读 README
           tool      read README.md
           message 1 我先读一下 README。
           tool      bash grep -n install
           message 2 README 里的安装步骤是 npm i -g pi。
```

| Mode     | QQ bubbles                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `full`   | ① 💭 thinking ② 📖 read + result ③ 我先读一下 README。 ④ 💻 bash + result ⑤ README 里的安装步骤是 npm i -g pi。 |
| `simple` | ① 我先读一下 README。 ② README 里的安装步骤是 npm i -g pi。                                                     |
| `last`   | ① README 里的安装步骤是 npm i -g pi。（sent when the run ends）                                                 |

## 4. Configuration

`~/.pi/agent/pi-qq.json`:

```json
{
  "replyType": "full"
}
```

| Key         | Type                           | Default  | Meaning                      |
| ----------- | ------------------------------ | -------- | ---------------------------- |
| `replyType` | `"full" \| "simple" \| "last"` | `"full"` | How much of a run reaches QQ |

- An invalid value is ignored and falls back to the default, with a warning at session start: `replyType must be "full", "simple", or "last"`.
- `thinkingRelay` only applies to `full`; in `simple` and `last` thinking is never relayed.
- `deliverAs` is unrelated: it controls how QQ messages enter pi, `replyType` controls how pi's output returns to QQ.
- The default stays `full`, so upgrading changes nothing and there is no migration step.

## 5. Implementation

### 5.1 Layers

| File                              | Change                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/infra/reply-type.ts` (new)   | `ReplyType`, `REPLY_TYPES`, `DEFAULT_REPLY_TYPE = "full"`, `isReplyType()`                             |
| `src/infra/settings.ts`           | `PiQQSettings.replyType`, validation in `parseConfig()`, default in `getSettings()`                    |
| `src/infra/i18n.ts`               | `settings.replyType`, `status.replyType`, `commands.last.running`                                      |
| `src/relay/reply-policy.ts` (new) | `ReplyPolicy` + `policyFor(type)`                                                                      |
| `src/relay/run-stream-relay.ts`   | Policy lookup per event; `lastText` buffering; end-of-run delivery and fallback; `onFallbackReply` dep |
| `src/qq/inbound-command.ts`       | `/last` replies with a notice in `last` mode while a task is running                                   |
| `src/qq/qq-message-handler.ts`    | `InboundDeps.getReplyType`                                                                             |
| `src/qq/status-report.ts`         | `💬 Reply type: <mode>` line                                                                           |
| `index.ts`                        | `getReplyType` / `onFallbackReply` wiring, `replyType` in session and bot logs                         |

`src/relay/bubble-writer.ts` is mode-agnostic: the writer only puts text into bubbles, and every mode difference is absorbed by `RunFeedback`.

### 5.2 Policy

```ts
export interface ReplyPolicy {
  relayThinking: boolean;
  relayTools: boolean;
  relayTextLive: boolean;
  deferTextWhileToolsPending: boolean;
  deliverLastAtEnd: boolean;
}
```

| Mode     | relayThinking             | relayTools | relayTextLive | deferTextWhileToolsPending | deliverLastAtEnd |
| -------- | ------------------------- | ---------- | ------------- | -------------------------- | ---------------- |
| `full`   | yes (and `thinkingRelay`) | yes        | yes           | yes                        | no               |
| `simple` | no                        | no         | yes           | no                         | no               |
| `last`   | no                        | no         | no            | no                         | yes              |

### 5.3 `last` mode

State: `RunState.lastText` holds the latest assistant message that has text.

- `onAssistantDelta(snapshot, thinking)`: nothing is pushed; a non-empty snapshot updates `lastText`.
- `onAssistantFinal(text, isError)`: a non-empty, non-error text becomes `lastText` and the call returns `true`, which suppresses the plain-message fallback in `index.ts` (the message is delivered at the end of the run instead). An error returns `false`, so the error keeps going out immediately through `sendReply`.
- `onAgentEnd()`: `planLastDelivery()` delivers `lastText`:
  1. if `budget.snapshot().fresh` is false (the inbound message is older than the passive window), skip the stream and use the plain message path directly;
  2. otherwise push the text into the bubble, rotate, flush, and `DONE`;
  3. if the stream fails, fall back to `onFallbackReply(text)`, which reuses `sendReply()` — passive first, proactive when the window expired, chunked at 4500 characters.

```text
QQ message ─▶ agent_start
              ├─ thinking / tools / intermediate assistant text ─▶ dropped (latest text buffered)
              ├─ message_end(last assistant message) ─▶ lastText = "..."
              └─ agent_end
                   ├─ budget stale? ──yes──▶ sendReply(plain message)
                   └─ no ─▶ writer.pushText(lastText) ─▶ flush
                              ├─ ok ─▶ DONE
                              └─ fail ─▶ onFallbackReply(lastText) ─▶ sendReply(plain message)
```

### 5.4 Commands

| Command        | Behaviour                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/last` (busy) | `full` / `simple`: `repushCurrent()`, the current assistant text is pushed to the new `msg_id`. `last`: a localized notice, no repush. |
| `/last` (idle) | The last completed reply is re-pushed as a stream, in every mode.                                                                      |
| `/stop`        | Aborts the run; `agent_end` still fires, so `last` mode still delivers the buffered text.                                              |
| `/status`      | Session, context, and battery; unaffected by the mode.                                                                                 |

### 5.5 Debug logs

- `session started`, `starting bot`, and `run started` carry `replyType`.
- `last` mode adds `run / last buffered` (`textLength`, `isError`) and `run / last delivered` (`delivered`, `fallback`).
- The `last delivered` record must be written **before** the run state is cleared: the log gate only opens while a QQ run is active, so `onAgentEnd()` now nulls `this.run` after the final flush and guards it with `if (this.run === run)`.

## 6. The 12k bubble split fix

This defect is unrelated to `replyType`; it existed in `full` mode as well.

**Symptom**: a single assistant message longer than 12k characters was not split. One measured message of 12590 characters used a single `stream_msg_id` for all 28 frames.

**Cause**: the split condition was `(blockBoundary || this.lastChar === "\n")`.

- `blockBoundary` is only true on a block switch, so it is always false for a continuous text stream;
- `this.lastChar === "\n"` requires the **previously pushed chunk** to end with a newline. Chunks arrive at the provider's SSE granularity, which has nothing to do with content, so this is a lottery. The measured message had 14 newlines after the 12k mark (all with the code fence closed) and none of them coincided with a chunk boundary.

**Impact**: no error, no lost content, no dead stream — the platform splits on its own when its own limit is hit. The cost is that the split point is chosen by the platform (possibly mid-line) and that a platform-split continuation bubble does not repeat the `## 💭` heading, so the v3 intent ("split at the 12k boundary and repeat the header") was lost.

**Fix**: find the split point in the chunk that is being pushed:

```ts
private splitPoint(text: string, newBubble: boolean): number {
  if (newBubble) return -1;
  if (!this.cur) return -1;
  if (this.pendingResume) return -1;
  if (this.fenceOpen) return -1;
  if (this.toolOpen) return -1;
  if (this.bubbleChars < MAX_BUBBLE_CHARS) return -1;
  return text.indexOf("\n");
}
```

When a split point exists, the chunk is appended in two parts with a bubble rotation in between: the old bubble ends with the newline, the new bubble starts at a line start, and a thinking block repeats its `## 💭` heading. When the chunk has no newline, nothing is split yet and the next chunk with a newline is used. The overshoot is the distance to the next newline in the stream — normally tens of characters. Pathological single-line content is left to the platform.

Unchanged constraints: never split inside an open code fence, never split while a tool block is open (tool header and result stay together), never split while a resume checkpoint is pending.

## 7. Verification

Automated:

- **224 tests passed** across 19 files (22 new: settings 5, relay 13, inbound command 2, status report 2, i18n 1).
- `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm pack --dry-run` passed.

Real QQ, log `~/project/mine/pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-09.log`:

| Case                             | Result                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `last`, 5 runs                   | Exactly one stream message per run, each containing only the final assistant text (284 / 899 / 1263 / 1147 / 232 characters)                                    |
| `last`, long run                 | Typing indicator kept the chat alive every 50s for a 4.5-minute run                                                                                             |
| `last`, media tool               | `qq_send_media` uploaded and sent the image (passive) even though the tool bubble was suppressed                                                                |
| `last`, log gap                  | The `last delivered` record was missing because the log gate closed first; fixed, with a regression test                                                        |
| `simple`, 26 runs                | 39 frames in 3 bubbles; **0** frames contained a tool or thinking marker                                                                                        |
| `simple`, live streaming         | A 12590-character message was streamed in 28 frames over ~27 seconds                                                                                            |
| `simple`, one bubble per message | Two assistant messages produced two bubbles                                                                                                                     |
| Provider rate limit              | 25 runs ended with the model provider's `429` TPM limit; each error was delivered immediately as a plain message, proactive once the passive window had expired |
| 12k split                        | The 12590-character message stayed in one bubble (the defect above); fixed in this release                                                                      |

Not covered by the acceptance run:

- a message long enough to cross the platform's own limit, so the platform-side auto split was not observed;
- `last` mode with a run longer than the passive window (the stale-target fallback path was only exercised in tests);
- the `simple` mode tool-output suppression was verified from the logs, not from the QQ client rendering.

## 8. Risks and limitations

| Risk                                                            | Impact                                                    | Handling                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| The default stays `full`, so `simple` / `last` are opt-in       | None for existing users                                   | Documented in both READMEs and the CHANGELOG                                         |
| `last` sends nothing while the run is in flight                 | A long task looks idle on the phone                       | The typing indicator keeps running; a progress hint is a possible follow-up          |
| `last` delivers at the end, when the passive window may be gone | The final message becomes a proactive message             | `budget.snapshot().fresh` pre-check plus a plain-message fallback                    |
| `simple` pushes text while a tool is still running              | Different from "collect everything after the tools"       | Documented; the mode is opt-in                                                       |
| `thinkingRelay` has no effect in `simple` / `last`              | May confuse users                                         | Both READMEs state it explicitly                                                     |
| `/last` during a run is unavailable in `last` mode              | The manual rescue path for stuck runs is gone             | The command answers with a localized notice; the run still delivers its last message |
| `onAssistantFinal` returns `true` in `last` mode                | "Handled" now means "delivered later", not "already sent" | Documented in the design and in the code                                             |

## 9. Open work

- [doc/todo.md](../todo.md) item 1: long-running bash argument visibility.
- [doc/todo.md](../todo.md) item 2: long-running tools leading to missing QQ output.
- `doc/todo.md` recommends using `/last` to recover a stuck run; in `last` mode that path is unavailable during the run, and the note should say so.
- Whether `last` needs a progress hint (D1) once real usage shows the waiting feels too long.
- Whether the platform's own bubble limit should be measured, so the 12k margin can be tuned.

## 10. References

- Design history: [delivery.2026.11.05.md](./delivery.2026.11.05.md).
- User-facing behavior: [README.md](../../README.md), [README-zh.md](../../README-zh.md).
- Earlier split design: [delivery.2026.11.03.md](./delivery.2026.11.03.md) §3 (12k split, repeated header).
- pi extension API: `pi/packages/coding-agent/docs/extensions.md` (`message_update`, `message_end`, `agent_end`).
- QQ SDK: `@tencent-connect/qqbot-nodejs` 1.0.5, `src/protocol/api/messages.ts` (`sendC2CStreamMessage`).
