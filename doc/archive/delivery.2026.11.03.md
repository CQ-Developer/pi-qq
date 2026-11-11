# pi-qq delivery-v3

> **Archived record.** Content reflects the delivery at that time and may reference removed modules or settings. See [README](../../README.md) for current behavior.
> Status: v3 implemented and the main path has been verified on real QQ.
> Note: later changes removed the image-specific pipeline; images now use the same save/pending path as files.
> Previous: [delivery.2026.10.29.md](./delivery.2026.10.29.md), [delivery.2026.10.30.md](./delivery.2026.10.30.md).

## 1. Scope

v3 consolidates long-run relay and configuration:

- F12: event-driven relay of thinking, tools, and text by content block;
- F13: remove message heartbeats;
- F14: consolidate settings.

## 2. Output model

### 2.1 One bubble per content block

In chronological order:

1. thinking block;
2. each tool call + result;
3. text block;
4. final message.

While tools are pending, later thinking/text is deferred so it cannot appear between two tool bubbles. Parallel tools are shown one at a time in start order; results are correlated by `toolCallId`.

### 2.2 Thinking format

The first line of every thinking bubble:

```text
**💭 思考**
```

The body is plain text with no `>` quote prefix; blank lines and newlines are preserved. At the 12k safety boundary the relay starts a new bubble and repeats the header.

Blockquotes are not used because QQ renders single-line/blank-line quote blocks as unsupported messages; plain text plus a header renders reliably.

### 2.3 Tool format

````text
**<icon> <tool>**

`argument`

```text
output
````

````

Failed results start with:

```text
❌ ...
````

Each tool call gets its own bubble; the tool header, argument, and result are never split.

Fixed icon map:

| Tool     | Icon | Tool         | Icon |
| -------- | ---- | ------------ | ---- |
| `bash`   | 💻   | `read`       | 📖   |
| `write`  | 📝   | `edit`       | ✏️   |
| `grep`   | 🔎   | `search`     | 🔍   |
| `find`   | 🗂️   | `ls`         | 📁   |
| `list`   | 📋   | `web`        | 🌐   |
| `fetch`  | 📡   | `delete`     | 🗑️   |
| `remove` | ❌   | `todo`       | ✅   |
| `test`   | 🧪   | unconfigured | 🔧   |

Icons are hard-coded in `src/relay/stream-block-format.ts`; no setting is added.

### 2.4 Text and ordinary messages

Assistant text is appended as-is and has no extra header. Text and tool blocks are separated by bubble boundaries.

## 3. Bubble splitting and streaming

- A run normally produces multiple bubbles, but each bubble carries one content block.
- When one block reaches `MAX_BUBBLE_CHARS = 12_000`, split at a safe boundary:
  - block boundary or line start;
  - no open code fence;
  - no pending resume checkpoint;
  - no active tool.
- Thinking splits favor line/list structure and do not truncate mid-line.
- Tool header/argument and result always stay in the same bubble.
- `AppendStream` enforces the 300ms platform floor, 500ms default batching, 429/50002 backoff, and same-bubble resume.
- `index` advances after every send attempt; an unconfirmed failed frame is retried with the next index.
- After five minutes or a platform rejection, the final text falls back to the normal message path.

## 4. Abort and error recovery

### 4.1 `/stop`

The `/stop` flow:

1. cancel the recovery target;
2. abort the agent;
3. wait for `agent_end` to finish the current stream, tool results, and DONE;
4. reply `Abort requested.`

Started tool results are therefore not lost, and queued tool bubbles do not appear after the abort reply.

### 4.2 Model error recovery

- After a model error, keep the original QQ target for 60 seconds.
- New runs created by pi's automatic recovery/retry reuse the same `msgId`.
- An empty retry that produces no output does not consume the recovery target; the next retry can still attach.
- A new QQ message or `/stop` cancels recovery.
- A local run inside the recovery window can also be relayed. This is an explicit trade-off to preserve pi's automatic recovery.

## 5. Settings

`~/.pi/agent/pi-qq.json` stores settings only; credentials are never written there.

| Setting         | Default        | Description                               |
| --------------- | -------------- | ----------------------------------------- |
| `thinkingRelay` | `true`         | Relay plain-text thinking blocks          |
| `deliverAs`     | `"steer"`      | Queue behavior while busy                 |
| `imageMaxSize`  | 10MB           | Image download limit                      |
| `fileMaxSize`   | 50MB           | File download limit                       |
| `logLevel`      | `"silent"`     | Log threshold                             |
| `debug`         | migration only | `debug: true` maps to `logLevel: "debug"` |

Removed settings: `streamRelay`, `streamFlushMs`, `streamAssistant`, `markdownSupport`, `heartbeatMinutes`, `heartbeatMaxMessages`. Old keys are ignored and not written back.

## 6. Modules and boundaries

The code is layered by responsibility:

<!-- prettier-ignore -->
| Module                       | Responsibility                                                            |
| ---------------------------- | ------------------------------------------------------------------------- |
| `index.ts`                   | Extension wiring, pi event subscriptions, login/session commands          |
| `src/qq/qq-diagnostics.ts`      | Terminal protocol diagnostics (`/qq-test-*`)                              |
| `src/qq/qq-message-handler.ts`  | QQ inbound routing, commands, attachments, injection into pi              |
| `src/qq/reply-sender.ts`        | Markdown-to-text conversion, chunking, sending                            |
| `src/relay/run-stream-relay.ts`    | Content-block orchestration, bubble lifecycle, tool queue, recovery       |
| `src/relay/stream-block-format.ts` | Thinking header, tool icons, argument/result formatting                   |
| `src/relay/stream-session.ts`      | Stream frames, batching, retries, resume checkpoints                      |
| `src/quota/reply-quota.ts`         | Passive reply quota and `msgId` window                                    |
| `src/quota/reply-quota-report.ts`  | Quota diagnostic text                                                     |
| `src/infra/settings.ts`            | Settings reading and legacy-key migration                                 |
| `src/qq/qq-bot.ts`              | QQBot/Gateway lifecycle and middleware                                    |
| `src/qq/qr-login.ts`            | QR login                                                                  |
| `src/attachments/file-attachments.ts`    | File storage, index, deduplication, pending files                         |
| `src/attachments/image-attachments.ts`   | Image validation and vision input                                         |
| `src/attachments/attachment-download.ts` | Shared limited download for images/files                                  |
| `src/attachments/voice-transcript.ts`    | QQ ASR text extraction                                                    |
| `src/infra/file-logger.ts`         | Structured file logging                                                   |
| `src/infra/display-format.ts`      | Byte/token display formatting                                             |

Boundary rules:

- `index.ts` does not own the relay state machine.
- `stream-block-format.ts` is pure formatting and does not depend on streams.
- `run-stream-relay.ts` orchestrates and does not build Markdown details.
- `stream-session.ts` does not know content-block semantics.
- `qq-message-handler.ts` does not implement download, storage, or quota.
- All configuration goes through `settings.ts`.
- Modules are independently testable or receive dependencies from the entrypoint.

## 7. Verification

- Unit tests at v3 delivery: **135 passed** across 14 test files.
- TypeScript, ESLint, and Prettier checks pass.
- Verified on real QQ:
  - C2C login, text, images, and files;
  - thinking/tool/text rendered as separate blocks;
  - tool header/result in the same bubble;
  - 12k split with repeated header;
  - `/stop` teardown and automatic recovery after model errors.
- Still worth a final pass:
  - long list splitting on the target client;
  - extremely long unclosed code fences;
  - recovery near the TTL boundary;
  - message quota with many parallel tools.

## 8. Risks and limitations

- One bubble per block increases message count; long runs need quota monitoring.
- 12k splitting is stateful; extreme single-line or unclosed-fence content may still fall back to platform splitting.
- Tool icons are hard-coded Emoji; rendering may vary by QQ client font.
- Recovery has a 60-second TTL; it stops after the window.
- C2C private chat only; credentials live in process memory.
- If streaming fails, the final text uses the normal message path and may duplicate already-visible content. Completeness is prioritized.
