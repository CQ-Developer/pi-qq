# pi-qq

[English](./README.md) | [简体中文](./README-zh.md)

Connect [pi](https://github.com/earendil-works/pi) to a QQ private chat. Send text, voice, images, or files from QQ; pi works on your machine and sends the result back.

## Requirements

- Node.js 22.19 or newer, matching pi.
- A QQ bot application with C2C private messaging enabled.
- A working pi installation.

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

Send a private message to the bot to start a task.

- **Text**: normal chat message.
- **Voice**: QQ's built-in ASR text is sent to pi. The audio is not downloaded or saved. If ASR returns no text, the bot asks you to resend or type it.
- **Images and files**: saved under `.pi/pi-qq/<sessionId>/uploads/`. If the message has no instruction, pi waits for your next text or voice message.

QQ clients differ in mixed-message support. Mobile QQ usually sends one message type at a time; desktop QQ can send text with an image. When a client includes text or voice together with attachments, pi-qq processes them in the same prompt.

### Attachments

An attachment-only message does **not** start pi. Files and images are saved, and pi waits for the next text or voice instruction.

- Send one or more files or images, then send a text or voice message describing what to do.
- The next instruction includes the saved attachment paths.
- Multiple attachments uploaded before the instruction are combined into one prompt.
- Images are read through pi's `read` tool, so the current model must support image input to see them.
- `/new` clears attachments waiting for an instruction.
- Uploads are scoped to the current pi session. Same filename and identical content reuse the existing file; same filename with different content becomes `name-1.ext`; different filenames with identical content are kept separately.

Example prompt seen by pi:

```text
# Attachments:
- .pi/pi-qq/<sessionId>/uploads/report.pdf

# User message:
Summarize this file.
```

### Voice messages

Voice messages use QQ's built-in ASR (`asr_refer_text`). The transcript is sent to pi as normal user text; pi never receives the audio file.

- The voice attachment is not downloaded or saved as `.amr` / `.silk`.
- No local or external speech-to-text service is used.
- If QQ ASR returns no text, the bot replies `Could not transcribe this voice message; please resend or type it.` and does not start a pi run.
- Voice and text are separate QQ messages; send them one after another when needed.
- If a client sends files or images together with a voice message, they are processed with the transcript.

Debug logs include the raw `asr_refer_text` and attachment metadata when `logLevel` is set to `debug`.

### Reply format

- **Thinking**: its own bubble, plain text, starting with `**💭 思考**`. Long thinking may continue in a new bubble with the header repeated.
- **Tools**: one bubble per call: `**<icon> <name>**`, blank line, inline-code argument, blank line, then the result in a `text` code block.
- **Regular messages**: raw text with no header.
- **Tool icons**: 💻 bash, 📖 read, 📝 write, ✏️ edit, 🔎 grep, 🔍 search, 🗂️ find, 📁 ls, 📋 list, 🌐 web, 📡 fetch, 🗑️ delete, ❌ remove, ✅ todo, 🧪 test; unconfigured tools use 🔧.
- **Error recovery**: after a model error, automatic retry runs within 60 seconds keep pushing to the original QQ chat. `/stop` waits for active tools and streams to finish before replying.

## Commands

Run these in the pi terminal:

| Command      | Description                                            |
| ------------ | ------------------------------------------------------ |
| `/qq-login`  | Log in with a QR code and bind the scanning QQ user    |
| `/qq-status` | Show login, connection, model, context, and bound user |
| `/qq-logout` | Log out and clear in-memory credentials                |
| `/qq-new`    | Reset the current session (used by QQ `/new`)          |

QQ-side commands:

| Command    | Description                                                              |
| ---------- | ------------------------------------------------------------------------ |
| `/new`     | Start a new pi session                                                   |
| `/stop`    | Abort the current run                                                    |
| `/compact` | Compact the current context                                              |
| `/status`  | Show session and context status                                          |
| `/last`    | Push the last completed reply as a stream, or restart the current output |
| `/help`    | Show command help                                                        |

### Diagnostics

These terminal commands are intended for troubleshooting:

| Command              | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `/qq-test-budget`    | Show passive-reply budget and stream-bubble diagnostics |
| `/qq-test-md [text]` | Send a Markdown test message                            |
| `/qq-test-stream`    | Run a streamed timeline diagnostic (`resume` for probe) |

## Settings

Create `~/.pi/agent/pi-qq.json` to override defaults. It stores settings only; credentials are never written to it.

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

Settings are read when a pi session starts; restart pi after editing the file. Unknown keys are ignored, and invalid values fall back to defaults with a warning.

When logging is enabled, logs are written to `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`. `PI_QQ_LOG_DIR` overrides the directory. `info` records metadata only; `debug` records full events, attachments, prompts, and tool payloads.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run format:check
```

The extension entrypoint is `index.ts`. Source modules are grouped by responsibility:

| Directory          | Responsibility                                      |
| ------------------ | --------------------------------------------------- |
| `src/qq/`          | QQ bot lifecycle, login, inbound handling, replies  |
| `src/relay/`       | Streamed thinking/tool/text relay                   |
| `src/attachments/` | Attachment download, storage, and voice transcripts |
| `src/quota/`       | Passive reply budget                                |
| `src/infra/`       | Settings, logging, and display formatting           |

## Notes

- Only C2C (QQ private chat) is supported.
- Runs triggered by inbound QQ messages are relayed to QQ. Unrelated tasks started directly in pi stay local.
- Images are saved as files and read through pi's `read` tool; the current model must support image input to see them.
- Saved attachments are workspace-local under `.pi/`; add `.pi/` to your own project `.gitignore` if needed.
- QQ limits passive replies per inbound message. Use `/qq-test-budget` to inspect the local budget.

## License

MIT
