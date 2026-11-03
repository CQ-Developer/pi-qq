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
- **Images**: saved with files under `.pi/pi-qq/<sessionId>/uploads/`; if the message has no instruction, pi waits for your next message.
- **Files**: saved under `.pi/pi-qq/<sessionId>/uploads/` and wait for your next instruction.

QQ client support for mixed messages varies. Mobile QQ generally sends one message type at a time; desktop QQ can send text with an image. When a client includes text or voice together with attachments, pi-qq processes them in the same prompt.

### QQ output format

- **Thinking**: its own bubble, plain text, with `**💭 思考**` as the first line. When a long thought continues in a new bubble at a 12k line boundary, the header is repeated.
- **Tools**: one bubble per call: `**<icon> <name>**`, blank line, inline-code argument, blank line, then the result in a `text` code block.
- **Regular messages**: raw text with no header.
- **Tool icons**: 💻 bash, 📖 read, 📝 write, ✏️ edit, 🔎 grep, 🔍 search, 🗂️ find, 📁 ls, 📋 list, 🌐 web, 📡 fetch, 🗑️ delete, ❌ remove, ✅ todo, 🧪 test; unconfigured tools use 🔧.
- **Error recovery**: after a model error, automatic retry runs within 60 seconds keep pushing to the original QQ chat. `/stop` waits for active tools and streams to finish before replying.

### Files and images

An attachment-only message does **not** start pi. Files and images are saved, and pi waits for your next text or voice instruction before processing them.

- Send one or more files or images, then send a text or voice message describing what to do.
- The next text/voice message is used as the instruction; the saved path(s), size, and original filename are added to that prompt.
- Multiple attachments uploaded before the instruction are combined into one prompt.
- Images are viewed through pi's `read` tool, so the current model must support image input to see them.
- `/new` clears attachments waiting for an instruction.
- Uploads are scoped to the current pi session. If you upload the same filename with identical content, pi reuses the existing file; the same filename with different content is saved as `name-1.ext`; different filenames with identical content are kept as separate files.

Example attachment prompt seen by pi:

```text
User sent the following attachment(s) via QQ (saved locally; use read/bash or other tools to access):
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
- If a client sends files or images together with a voice message, they are processed with the transcript.
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
| `/qq-test-stream`    | Run a streamed timeline diagnostic (`resume` for probe) |
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
  "thinkingRelay": true,
  "logLevel": "silent"
}
```

| Key             | Default    | Description                                                  |
| --------------- | ---------- | ------------------------------------------------------------ |
| `thinkingRelay` | `true`     | Relay thinking as plain text with a `💭 思考` header         |
| `deliverAs`     | `"steer"`  | Queue new messages while busy: `steer` or `followUp`         |
| `fileMaxSize`   | `52428800` | QQ attachment download limit in bytes (50MB)                 |
| `logLevel`      | `"silent"` | Log threshold: `silent`, `error`, `warn`, `info`, or `debug` |

The old `imageMaxSize` key is ignored; images share the `fileMaxSize` limit.

When enabled, logs are written to `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`. `PI_QQ_LOG_DIR` overrides the directory. `info` records metadata only; `debug` records full events, attachments, prompts, and tool payloads. Legacy `debug: true` maps to `logLevel: "debug"`.

Settings are read when a pi session starts; restart pi after editing the file. Unknown keys are ignored, and invalid values fall back to defaults with a warning.

## Development

Node.js 22.19 or newer is required, matching pi. Install dependencies and run:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run format:check
```

`eslint.config.ts` is loaded through Node.js native TypeScript stripping; `jiti` is not required.

### File naming

- Source files use `<domain>-<role>.ts`, for example `qq-bot.ts`, `qq-message-handler.ts`, `reply-sender.ts`, `reply-quota.ts`, `stream-session.ts`, `stream-block-format.ts`, `run-stream-relay.ts`, and `file-attachments.ts`.
- Source directories group bounded contexts: `src/qq/`, `src/relay/`, `src/attachments/`, `src/quota/`, and `src/infra/`.
- Test files mirror the source path and file name: `test/<group>/<source>.test.ts`, for example `test/relay/run-stream-relay.test.ts`.
- Type-only modules use the `.d.ts` suffix; `.d.ts` means TypeScript declaration file and contains no runtime code. Example: `qrcode-terminal.d.ts`.
- Avoid vague standalone names such as `inbound`, `outbound`, `format`, `util`, or `helpers`; encode the domain and responsibility instead.

## Notes

- Only C2C (QQ private chat) is supported.
- Runs triggered by inbound QQ messages are relayed to QQ, as are automatic retry runs after model errors. Unrelated tasks started directly in pi stay local.
- Incoming images are saved as files and read through pi's `read` tool; the current model must support image input to see them.
- Saved attachments are workspace-local under `.pi/`; add `.pi/` to your own project `.gitignore` if needed.
- QQ limits passive replies per inbound message. Use `/qq-test-budget` to inspect the local budget.
