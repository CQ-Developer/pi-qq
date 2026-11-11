# pi-qq delivery-v4

> **Archived record.** Content reflects the v4 delivery snapshot and may reference behavior that has since changed. See [README](../../README.md) for current behavior.
> Status: v4 delivered. Tool block types were verified on real QQ; long-running tool handling and offline delivery remain open items.
> Version: 1.4.0
> Date: 2026-11-04
> Previous: [delivery.2026.10.29.md](./delivery.2026.10.29.md), [delivery.2026.10.30.md](./delivery.2026.10.30.md), [delivery.2026.11.03.md](./delivery.2026.11.03.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

v4 is an output-quality and observability release. This record consolidates six former v4 working documents (names are historical):

- tool start visibility (`tool-return`);
- skill display (`send-skill`);
- `/status`, language, and battery (`enhance-status`);
- QQ background delivery (`bugfix-v4`);
- long-running tools (`long-tool`);
- tool result code-block types (`block-type`).

The main changes are:

1. a new tool output format with typed code blocks;
2. a dedicated Skill block for `SKILL.md` reads;
3. `/status` and `/qq-status` with agent state, language, and battery;
4. QQ-side `/last` as a manual recovery path;
5. debug diagnostics for long tools and stream failures.

The release does not change the transport: pi-qq still uses QQ C2C private messages, passive replies, and `stream_messages` for long output.

## 2. Tool output

### 2.1 Layout

Each content block gets its own bubble. Thinking stays plain text:

```text
**💭 思考**

reasoning...
```

Tool calls use a second-level heading:

````markdown
## 💻 bash

```bash
npm test
```

```text
12 passed
```
````

Rules:

- the tool header is `## <icon> <name>`;
- `bash` commands use a `bash` code block and preserve newlines;
- commands are displayed in full, without the old 200-character argument limit;
- `read` / `write` / `edit` keep their path as inline code;
- other tools keep their primary argument as inline code;
- tool call and result stay in the same bubble;
- a tool bubble is never split between the call and its result.

Result code-block language is chosen by tool and, for `read`, by file extension:

| Source                | Result language                                       |
| --------------------- | ----------------------------------------------------- |
| `bash`                | `text`                                                |
| `write`, `edit`       | `text`                                                |
| `read`                | language from extension; unknown falls back to `text` |
| error or empty result | `text`                                                |
| other tools           | `text`                                                |

Common mappings include `md` → `markdown`, `json` → `json`, `yaml` → `yaml`, `ts` → `typescript`, `tsx` → `tsx`, `js` → `javascript`, `py` → `python`, `sh`/`bash`/`zsh` → `bash`, `html` → `html`, `css` → `css`, `sql` → `sql`, `rs` → `rust`, `go` → `go`, and `diff`/`patch` → `diff`.

Special file names:

- `Dockerfile` → `dockerfile`;
- `Makefile` → `makefile`;
- `CMakeLists.txt` → `cmake`;
- `README` → `markdown`.

Empty and failed results always use `text`. Result text is still capped at 600 characters / 8 lines; the bash command itself is not truncated.

Fixed tool icons:

| Tool     | Icon | Tool     | Icon |
| -------- | ---- | -------- | ---- |
| `bash`   | 💻   | `read`   | 📖   |
| `write`  | 📝   | `edit`   | ✏️   |
| `grep`   | 🔎   | `search` | 🔍   |
| `find`   | 🗂️   | `ls`     | 📁   |
| `list`   | 📋   | `web`    | 🌐   |
| `fetch`  | 📡   | `delete` | 🗑️   |
| `remove` | ❌   | `todo`   | ✅   |
| `test`   | 🧪   | other    | 🔧   |

### 2.2 Skill block

A `read` of a `SKILL.md` file is rendered as:

```markdown
## 🧩 Skill

`playwright-cli`
```

- skill name is the parent directory;
- `path` and `file_path` are both supported;
- Unix and Windows separators are supported;
- the `SKILL.md` content is never forwarded;
- the generic `📖 read` line and its result are suppressed;
- each read produces one skill bubble; no de-duplication;
- QQ does not support `/skill:`; only model-initiated reads are detected.

### 2.3 Bubble boundaries

- Thinking, tools, and text are separate blocks.
- A run may produce many bubbles, but a tool call and result are always together.
- `MAX_BUBBLE_CHARS = 12_000` triggers a safe split at a block boundary or line start.
- Do not split inside an open code fence or while a resume checkpoint/tool is active.
- Parallel tools are shown one at a time in start order; results are correlated by `toolCallId`.
- Text and thinking that arrive while tools are pending are deferred so they cannot appear between a tool call and its result.

## 3. Status, language, and battery

QQ `/status` and terminal `/qq-status` share one formatter.

Current fields:

| Field      | Content                                                       |
| ---------- | ------------------------------------------------------------- |
| title      | `🖥️ pi-qq status` / `pi-qq 状态`                              |
| login      | QR login and masked AppID, or `not logged in`                 |
| connection | `connected`, `reconnecting`, `stopped`, `starting`, `blocked` |
| agent      | `running (QQ)`, `running (local)`, or `completed`             |
| model      | current model name                                            |
| context    | tokens / window / percent                                     |
| QQ user    | masked bound openid                                           |
| battery    | percent and charging/discharging/AC; omitted when no battery  |
| settings   | `~/.pi/agent/pi-qq.json`                                      |

Agent state uses `ctx.isIdle()` as the global signal and `runFeedback.isQQRunActive()` to distinguish a QQ-triggered run from a local run.

Battery support:

- Linux: `/sys/class/power_supply/BAT*`;
- macOS: `pmset -g batt`;
- Windows: PowerShell `Get-CimInstance Win32_Battery`;
- 30-second cache;
- failures are silent and hide the battery line;
- no new npm dependency.

Language:

- new `language` setting: `"zh-cn"` or `"en-us"`;
- default is `"zh-cn"`;
- user-facing command replies, status text, errors, stream placeholders, and pi-qq log messages are localized;
- logs keep stable fields and add `msgKey` for language-independent filtering;
- SDK-originated errors and third-party log text remain unmodified;
- invalid values fall back to the default and produce a warning.

`QQ user` replaces the old `Bound user` label and masks the openid.

## 4. Tool start visibility

The investigation found that tool start information is delayed by the stream batching layer, not by the tool itself:

- `AppendStream` uses a 500ms throttle with a 300ms floor;
- a short tool call and its result can land in the same buffer and appear together;
- a long tool normally sends its start frame after about 500ms;
- parallel tools are serialized by `RunFeedback.activeTool`, so a later tool may wait for the current tool to finish.

The proposed `flushAfter` behavior was not implemented in v4. The block-type change still improves visibility because bash parameters are no longer a single inline-code line that QQ may collapse.

Version 1.3.6 added debug timing logs:

- tool enqueue / append start / append done;
- stream buffer, flush timer, and flush result;
- event-loop `meanMs`, `maxMs`, `p99Ms`, and later `driftMs`.

## 5. Long-running tools

### 5.1 Observed failure chain

A long tool can leave QQ silent because:

1. the run has no new assistant event while the tool runs;
2. the only tool frame is the start bubble;
3. a long gap makes the next stream frame likely to hit `msg_id` expiry or passive-reply limits;
4. `BubbleWriter` resumes with the same expired `msg_id` / `stream_msg_id`;
5. after resume attempts are exhausted, `killStream()` makes later tool output disappear;
6. `onToolEnd()` early-returns when the writer is dead, leaving `activeTool` and deferred text stuck;
7. only the final assistant text may fall back to a normal message, and that fallback becomes proactive after 5 minutes.

Additional contributing factors:

- each thinking/tool bubble is a new stream reply, but `ReplyBudget` does not count stream bubbles against the 4-reply limit;
- `/stop` waits for `waitForEnd()` before replying, which can hold the SDK concurrency guard;
- no `tool_execution_update` progress is forwarded;
- new QQ messages are queued as `steer` until the tool batch finishes.

### 5.2 What shipped

- debug diagnostics only; no behavior fix;
- QQ `/last` as the manual recovery path:
  - while running: `RunFeedback.repushCurrent()` rebinds to the new `/last` message and pushes current text;
  - when idle: `sendStreamReply()` pushes the latest completed assistant text.
- diagnostics added in 1.3.6 and the follow-up debug pass:
  - tool `durationMs`, `updateCount`, `updateSpanMs`, first partial output;
  - run target selection, tool queued/started/finished/ignored, assistant final decision, run cleanup;
  - writer `dead`, `hasPendingResume`, `resumeAttempts`, `lastFrameAgeMs`;
  - stream frame `httpStatus`, `bizCode`, `path`, `msgSeq`, `streamMsgId`, `bufferLength`;
  - `/stop` wait duration;
  - event-loop drift.

### 5.3 Known protocol risks

Not fixed in v4:

- stream bubble quota is not accounted;
- `DONE` frames currently have empty `content_raw`;
- stream requests send both `event_id` and `msg_id`, although the protocol says one of them;
- stream resume reuses expired identifiers;
- no pending-output queue for expired passive windows;
- no final ordinary-text fallback after a successful stream;
- SDK heartbeat ACK timeout is not implemented;
- session persistence is not enabled.

## 6. QQ background and offline delivery

The reported case was: iPhone QQ stays in the background for a long time, pi keeps running, and after reopening QQ no bot output from the offline period is visible. New inbound messages still reach pi, and the bot can reply to them.

The likely explanation is client-side/offline delivery: QQ does not replay the streamed bot content that was produced while the phone was offline. This was not fully confirmed because no incident log was available.

What v4 shipped:

- `/last` as a manual recovery path;
- status/diagnostic visibility for login, connection, agent, model, context, and budget.

What v4 did not ship:

- 60-minute passive-window correction (the code still uses 5 minutes);
- persistent final text after streaming;
- offline summary on the next inbound message;
- SDK heartbeat ACK timeout;
- session persistence;
- automatic rebind of an active run to a new inbound message.

## 7. Diagnostics

Terminal commands:

- `/qq-test-budget` — passive budget and stream bubble counters;
- `/qq-test-md [text]` — Markdown rendering test;
- `/qq-test-stream` — stream timeline and resume test.

Debug logging:

- enable `logLevel: "debug"` in `~/.pi/agent/pi-qq.json`;
- logs are written to `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`;
- `PI_QQ_LOG_DIR` can override the directory;
- `info` records metadata; `debug` records full events, attachments, prompts, and tool arguments/results.

## 8. Modules and boundaries

<!-- prettier-ignore -->
| Module | Responsibility |
| ------ | -------------- |
| `index.ts` | Extension wiring, pi events, login/session commands, status collection |
| `src/qq/` | QQ lifecycle, QR login, inbound routing, replies, diagnostics, status formatter |
| `src/relay/` | Thinking/tool/text relay, bubble layout, stream sessions, tool result formatting |
| `src/quota/` | Passive reply budget and diagnostics |
| `src/attachments/` | File download, storage, pending files, voice transcript |
| `src/infra/` | Settings, i18n, logging, power status, display formatting |

Boundary rules:

- formatting is pure and lives in `stream-block-format.ts`;
- relay orchestration lives in `run-stream-relay.ts` / `bubble-writer.ts`;
- stream frames and retries live in `stream-session.ts`;
- inbound QQ parsing and command routing live under `src/qq/`;
- all configuration goes through `settings.ts`;
- modules receive dependencies from the entrypoint and remain independently testable.

Images use the same save/pending path as files; the earlier image-specific pipeline and `imageMaxSize` were removed before v4.

## 9. Verification

- Unit tests: **172 passed** across 18 test files.
- TypeScript, ESLint, and Prettier checks pass.
- Real QQ block-type verification on 2026-11-04:
  - test directory: `/home/chen/project/pi-qq-test`;
  - files: `hello.py`, `Hello.java`, `hello.rs`, `hello.ts`;
  - log: `.pi/pi-qq/logs/pi-qq-2026-11-04.log`;
  - observed `## 💻 bash` with a bash block, `## 📖 read` with rust/typescript result blocks, `## 📝 write` with an inline path;
  - event-loop `driftMs` was 0–1ms and `maxMs` about 101ms.
- `/qq-test-stream` was not separately executed during this acceptance.
- A full manual pass of `/status` and long-running/offline scenarios is still recommended.

## 10. Risks and limitations

- Long tasks can exhaust the 4 passive replies because stream bubbles are not counted.
- A 5-minute-old message falls back to proactive delivery; users may disable active messages.
- Stream resume does not recover an expired `msg_id` / `stream_msg_id`.
- Long tools have no progress heartbeat; only `typing` is sent.
- Tool start may be delayed by the 500ms throttle.
- QQ Markdown support for language-specific highlighting varies by client.
- A 12k split is stateful; extreme single-line or unclosed-fence content may still hit platform behavior.
- C2C private chat only; credentials stay in process memory.
- Debug logs may contain prompts, tool arguments, and tool results.

## 11. Open items

- [doc/todo.md](../todo.md) item 1: long-running bash argument/tool-start visibility.
- [doc/todo.md](../todo.md) item 2: long-running tool leading to missing QQ output.
- Fix stream quota accounting before adding more per-block bubbles.
- Decide how to handle expired passive windows and pending output.
- Validate `DONE` content and the `event_id` / `msg_id` usage against the QQ API.
- Add a progress heartbeat or forward `tool_execution_update`.
- Add SDK heartbeat ACK timeout and consider session persistence.
- Decide whether `/status` and `/last` need further real-client acceptance.

Until the live logs confirm the failure mode, the investigation and diagnostics remain the source of truth; no speculative relay rewrite is included in v4.
