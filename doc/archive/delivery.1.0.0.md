# pi-qq delivery-v1

> **Archived record.** Content reflects the delivery at that time and may reference removed modules or settings. See [README](../../README.md) for current behavior.
> Status: v1 delivered; this is a historical baseline for later versions.
> Later versions: [delivery.1.2.0.md](./delivery.1.2.0.md), [delivery.1.3.0.md](./delivery.1.3.0.md).

## 1. Scope

v1 connects pi to a QQ private chat (C2C):

- send text, images, and files from mobile QQ;
- pi runs tasks on the user's machine;
- assistant text is relayed back to QQ;
- login, commands, reply quota, and connection lifecycle are managed.

Stack:

| Dependency                         | Purpose                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `@tencent-connect/qqbot-nodejs`    | QQ protocol: Gateway, C2C messages, media upload, stream messages |
| `@tencent-connect/qqbot-connector` | QR login; credentials stay in process memory                      |
| `@earendil-works/pi-coding-agent`  | pi extension host, events, message injection, context             |

## 2. Architecture

The extension is loaded as a directory and owns a QQBot inside the pi process:

```text
mobile QQ (C2C)
   │ WebSocket Gateway
   ▼
QQBot
   │ message
   ▼
pi-qq: allowlist → QQ commands → text/images/files
   │ pi.sendUserMessage()
   ▼
pi session
   │ message_update / message_end / agent_end
   ▼
pi-qq: format → QQ text/stream message
```

- QQ → pi: validate the allowlist, then inject text and images; files are saved in the workspace.
- pi → QQ: subscribe to assistant messages and relay them; long tasks use an independent feedback timeline.
- Lifecycle: `session_start` starts the bot; `session_shutdown` stops it idempotently.
- Reconnection is handled by the SDK; fatal close codes 4914/4915 produce explicit errors.

## 3. Features

### F1 QR login

- Login is only available through `/qq-login`.
- Credentials are kept in process memory, never in the config file; restarting pi requires scanning again.
- The scanning user's openid becomes the only allowed C2C peer.
- `/qq-logout` clears credentials and disconnects.
- `/qq-status` shows login, connection, model, context, and bound user; AppID is masked.

### F2 Single-user chat

- Accept only allowlisted C2C messages.
- Inject text through `pi.sendUserMessage()`.
- Queue messages while the agent is busy according to `deliverAs` (`steer` or `followUp`).
- QQ-side commands: `/new`, `/stop`, `/compact`, `/status`, `/help`.
- Send typing indicators during a run.

### F3 Images and files

Images:

- Download, validate type/size, and convert to pi's `ImageContent`.
- Supported: jpg/jpeg/png/webp/gif; unsupported `image/*` types are rejected.
- Per-image timeout: 15 seconds; default limit: 10MB.
- If some images fail, successful images are still injected and failures are reported.
- If the model has no vision support, notify the user and skip images.

Files:

- Saved under `.pi/pi-qq/YYYY-MM-DD/<msgId>/`; v2+ uses the session-scoped `.pi/pi-qq/<sessionId>/uploads/`. The prompt includes the absolute path, size, and original filename.
- Per-file timeout: 60 seconds; default limit: 50MB.
- Filenames are sanitized; duplicates get `-1`, `-2` suffixes.
- File contents are not injected into the model; tools read them on demand.

### F4 Assistant relay

- Source: assistant `message_end`.
- Convert Markdown to plain text: strip emphasis/headings/inline-code markers, convert list bullets to `•`, and keep link text plus URL.
- Split long text by `TEXT_CHUNK_LIMIT`.
- Support C2C stream append; fall back to normal messages if the platform rejects the stream.
- On `stopReason === "error"`, relay an error summary.

### F5/F6 Usage summary

Removed. Do not send token, cache, cost, or context details; use `/status` or `/qq-status` to inspect context usage.

### F7 Long-task feedback

v1 used window summaries, tool counts, and message heartbeats to keep long runs visible. This was replaced by F12/F13 in v3; v1 behavior is historical, not current.

## 4. Platform limits and quota

| Limit                                               | Mitigation                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| About 4 passive replies per hour (SDK limiter)      | `ReplyBudget` records `msgId` quota and falls back to proactive sends |
| Stream messages are C2C-only; throttle ≥300ms       | `AppendStream` handles batching and retries                           |
| About 5000 characters per text message              | Automatic chunking                                                    |
| Stream messages need a `msgId` newer than 5 minutes | Fall back to normal messages after expiry                             |

## 5. Settings and commands

`~/.pi/agent/pi-qq.json` stores settings only; credentials are never written there.

| Setting         | Default        | Description                               |
| --------------- | -------------- | ----------------------------------------- |
| `thinkingRelay` | `true`         | Relay thinking text                       |
| `deliverAs`     | `"steer"`      | Queue behavior while busy                 |
| `imageMaxSize`  | 10MB           | Image download limit                      |
| `fileMaxSize`   | 50MB           | File download limit                       |
| `logLevel`      | `"silent"`     | Log threshold                             |
| `debug`         | migration only | `debug: true` maps to `logLevel: "debug"` |

pi-side commands: `/qq-login`, `/qq-status`, `/qq-logout`, `/qq-test-budget`, `/qq-test-md`, `/qq-test-stream`, `/qq-new`.

QQ-side commands: `/new`, `/stop`, `/compact`, `/status`, `/help`.

## 6. Modules and boundaries (v1 baseline)

<!-- prettier-ignore -->
| Module                       | Responsibility                                              |
| ---------------------------- | ----------------------------------------------------------- |
| `index.ts`                   | Extension wiring, event subscriptions, command registration |
| `src/infra/settings.ts`            | Read-only settings and migration                            |
| `src/qq/qr-login.ts`            | QR login                                                    |
| `src/qq/qq-bot.ts`              | QQBot lifecycle, Gateway state, middleware                  |
| `src/qq/qq-message-handler.ts`  | Inbound routing, commands, attachments, injection into pi   |
| `src/attachments/image-attachments.ts`   | Image validation and `ImageContent`                         |
| `src/attachments/file-attachments.ts`    | File storage, index, prompt attachment                      |
| `src/attachments/attachment-download.ts` | Shared limited download for images/files                    |
| `src/qq/reply-sender.ts`        | Markdown conversion, chunking, sending                      |
| `src/quota/reply-quota.ts`         | Passive reply quota                                         |
| `src/quota/reply-quota-report.ts`  | Quota diagnostics formatting                                |
| `src/infra/display-format.ts`      | Byte and token formatting                                   |
| `src/infra/file-logger.ts`         | File logging                                                |
| `src/relay/run-stream-relay.ts`    | Long-task feedback state machine                            |
| `src/relay/stream-session.ts`      | Stream append, retries, checkpoint resume                   |

Boundary rules: the entrypoint only wires modules; protocol, storage, formatting, and quota are separate; modules communicate through explicit parameters and interfaces such as `RunFeedbackDeps`.

## 7. Verification

- QR login, `/qq-status`, and `/qq-logout` verified on real QQ.
- QQ text starts pi and the reply comes back.
- Images as vision input, file storage, and prompt path association verified.
- Passive reply quota stayed within limits; failure paths fell back to proactive sends.

## 8. Known limitations

- C2C private chat only.
- Credentials live in process memory; restarting pi requires scanning again.
- No start acknowledgement or usage summary, reducing passive messages.
- Historical stream/heartbeat behavior was replaced by v3 and is not current behavior.
