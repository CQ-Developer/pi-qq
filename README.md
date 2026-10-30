# pi-qq

[English](./README.md) | [简体中文](./README-zh.md)

Connect [pi](https://github.com/earendil-works/pi) to a QQ private chat. Send text, voice, images, or files from mobile QQ; pi works on your machine and sends the result back to QQ.

## Install

```bash
pi install npm:@chen_hu_hu/pi-qq
```

For local development:

```bash
pi --extension /path/to/pi-qq
```

## Login

1. Start pi.
2. Run `/qq-login`.
3. Scan the QR code with mobile QQ.

Credentials are kept in process memory only. Restarting pi requires scanning again. `/qq-logout` clears the in-memory credentials immediately.

## Usage

Send a QQ private message to the bot to start a task.

- **Text**: normal chat message.
- **Voice**: QQ built-in ASR text is sent to pi directly; the audio is not downloaded or saved. If ASR returns no text, the bot asks you to resend or type it.
- **Images**: sent to pi as vision input.
- **Files**: saved under the current workspace at `.pi/pi-qq/<sessionId>/uploads/` and wait for your next instruction.

### Files

A file-only message does **not** start pi. The file is saved, and pi waits for your next text or voice instruction before processing it.

- Upload one or more files, then send a text or voice message describing what to do.
- The next text/voice message is used as the instruction; the saved path(s), size, and original filename are added to that prompt.
- Multiple files uploaded before the instruction are combined into one prompt.
- `/new` clears files waiting for an instruction.
- Uploads are scoped to the current pi session. If you upload the same filename with identical content, pi reuses the existing file; the same filename with different content is saved as `name-1.ext`; different filenames with identical content are kept as separate files.

Example file prompt seen by pi:

```text
User sent the following file via QQ (saved locally; use read/bash or other tools to access it):
- /home/chen/project/myproj/.pi/pi-qq/<sessionId>/uploads/report.pdf (1.4MB, original name: report.pdf)

User message:
Summarize this file.
```

### Voice messages

Voice messages use QQ's built-in ASR (`asr_refer_text`). The transcript is sent to pi as normal user text; pi never receives the audio file.

- The voice attachment is not downloaded or saved as `.amr` / `.silk`.
- No local or external speech-to-text service is used.
- If QQ ASR returns no text, the bot replies `Could not transcribe this voice message; please resend or type it.` and does not start a pi run.
- Voice and text are separate QQ messages; send them one after another when needed.
- To inspect the raw ASR result, set `logLevel` to `debug`; the log includes `asr_refer_text` and attachment metadata.

## Commands

Run these in the pi terminal:

| Command              | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `/qq-login`          | Log in with a QR code and bind the scanning QQ user     |
| `/qq-status`         | Show login, connection, model, context, and bound user  |
| `/qq-logout`         | Log out and clear in-memory credentials                 |
| `/qq-test-budget`    | Show passive-reply budget and stream-bubble diagnostics |
| `/qq-test-md [text]` | Send a Markdown test message                            |
| `/qq-test-stream`    | Run a streamed timeline diagnostic                      |
| `/qq-new`            | Reset the current session (used by QQ `/new`)           |

QQ-side commands:

| Command    | Description                     |
| ---------- | ------------------------------- |
| `/new`     | Start a new pi session          |
| `/stop`    | Abort the current run           |
| `/compact` | Compact the current context     |
| `/status`  | Show session and context status |
| `/help`    | Show command help               |

## Settings

Create `~/.pi/agent/pi-qq.json` to override defaults. This file contains settings only; credentials are never written to it.

```json
{
  "markdownSupport": false,
  "streamFlushMs": 10000,
  "logLevel": "silent"
}
```

| Key                    | Default    | Description                                                  |
| ---------------------- | ---------- | ------------------------------------------------------------ |
| `streamAssistant`      | `true`     | Stream assistant replies                                     |
| `markdownSupport`      | `false`    | Bot has QQ Markdown permission; pass Markdown through        |
| `deliverAs`            | `"steer"`  | Queue new messages while busy: `steer` or `followUp`         |
| `imageMaxSize`         | `10485760` | QQ image download limit in bytes (10MB)                      |
| `fileMaxSize`          | `52428800` | QQ file download limit in bytes (50MB)                       |
| `heartbeatMinutes`     | `10`       | Long-task heartbeat interval; `0` disables                   |
| `heartbeatMaxMessages` | `3`        | Per-run message heartbeat limit                              |
| `streamRelay`          | `true`     | Use append-mode stream bubbles                               |
| `streamFlushMs`        | `10000`    | Stream summary frame interval in ms (minimum 300)            |
| `logLevel`             | `"silent"` | Log threshold: `silent`, `error`, `warn`, `info`, or `debug` |

When enabled, logs are written to `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`. `PI_QQ_LOG_DIR` overrides the directory. `info` records metadata only; `debug` records full events, attachments, prompts, and tool payloads. Legacy `debug: true` maps to `logLevel: "debug"`.

## Notes

- Only C2C (QQ private chat) is supported.
- Only runs triggered by inbound QQ messages are relayed to QQ. Tasks started directly in pi stay local.
- Incoming images are passed to the model as vision input; the current model must support image input.
- Saved files are workspace-local under `.pi/`; add `.pi/` to your own project `.gitignore` if needed.
- QQ limits passive replies per inbound message. Use `/qq-test-budget` to inspect the local budget.
