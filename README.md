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

Credentials are not written to `pi-qq.json`. Restarting pi requires scanning again. `/qq-logout` clears the credentials immediately.

## Usage

Send a private message to the bot to start a task.

- **Text**: normal chat message.
- **Voice**: QQ's built-in ASR transcript (`asr_refer_text`) is sent to pi as normal user text. The audio is not downloaded or saved, and no external speech-to-text service is used. If ASR returns no text, the bot asks you to resend or type it. Voice and text are normally separate QQ messages; send them in sequence when needed.
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
- Add `.pi/` to your project `.gitignore` if needed.

Example prompt seen by pi:

```text
# Attachments:
- .pi/pi-qq/<sessionId>/uploads/report.pdf

# User message:
Summarize this file.
```

### Sending media back to QQ

After QQ login, pi-qq activates the `qq_send_media` tool. It is registered inactive at startup and after `/qq-logout`; a reconnect does not disable it.

Ask pi explicitly, for example `send me the screenshot` or `把截图发给我`. The model decides from the tool description; ambiguous requests should be clarified first. There is no keyword matching or extra confirmation step.

- Images: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`; up to 30 MB.
- Videos: `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`, `.flv`, `.wmv`; up to 100 MB.
- Other files: up to 100 MB; audio is sent as a file.
- Any readable regular file is allowed. Symlinks, directories, and devices are rejected.
- Each media message consumes one passive reply; after the limit, pi-qq falls back to a proactive message.
- The tool bubble is the same as any other tool: `## 📤 qq_send_media`.

### Reply format

In `replyType: "full"` mode, QQ receives these block types:

- **Thinking**: its own bubble, plain text, starting with a localized `## 💭 <label>` heading (`Thinking` or `思考`). Long thinking may continue in a new bubble with the header repeated.
- **Tools**: one bubble per call: `## <icon> <name>`; `bash` commands use a `bash` code block, other arguments use inline code, and results use `text`, `markdown`, `python`, `json`, etc. depending on the tool and file type.
- **Regular messages**: raw text with no header.
- **Tool icons**: 💻 bash, 📖 read, 📝 write, ✏️ edit, 🔎 grep, 🔍 search, 🗂️ find, 📁 ls, 📋 list, 🌐 web, 📡 fetch, 🗑️ delete, ❌ remove, ✅ todo, 🧪 test; unconfigured tools use 🔧.

After a model error, automatic retries within 60 seconds keep pushing to the original QQ chat. `/stop` waits for active tools and streams to finish before replying.

## Commands

Run these in the pi terminal:

| Command      | Description                                            |
| ------------ | ------------------------------------------------------ |
| `/qq-login`  | Log in with a QR code and bind the scanning QQ user    |
| `/qq-status` | Show login, connection, model, context, and bound user |
| `/qq-logout` | Log out and clear credentials                          |
| `/qq-new`    | Reset the current session (used by QQ `/new`)          |

QQ-side commands:

| Command    | Description                                                                |
| ---------- | -------------------------------------------------------------------------- |
| `/new`     | Start a new pi session                                                     |
| `/stop`    | Abort the current run                                                      |
| `/compact` | Compact the current context                                                |
| `/status`  | Show session and context status                                            |
| `/last`    | Repush current output while running, or the last completed reply when idle |
| `/help`    | Show command help                                                          |

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
  "replyType": "full",
  "deliverAs": "steer",
  "fileMaxSize": 52428800,
  "language": "zh-cn",
  "logLevel": "silent"
}
```

| Key           | Default    | Description                                                   |
| ------------- | ---------- | ------------------------------------------------------------- |
| `replyType`   | `"full"`   | How much of a run is pushed to QQ: `full` or `simple`         |
| `deliverAs`   | `"steer"`  | Queue new messages while busy: `steer` or `followUp`          |
| `fileMaxSize` | `52428800` | QQ attachment download limit in bytes (50MB)                  |
| `language`    | `"zh-cn"`  | UI language: `zh-cn` or `en-us`; log files are always English |
| `logLevel`    | `"silent"` | Log threshold: `silent`, `error`, `warn`, `info`, or `debug`  |

Settings are loaded when the extension starts and re-read on every inbound QQ message from the bound user, so edits take effect on the next message without restarting pi or logging in again. Unknown keys are ignored, and invalid values fall back to defaults with a warning.

### `replyType`

How much of an agent run is pushed to QQ.

| Value    | QQ receives                                                                      |
| -------- | -------------------------------------------------------------------------------- |
| `full`   | Thinking blocks, tool calls, tool results, and every assistant message (default) |
| `simple` | Assistant messages only, one bubble each                                         |

- `full` is the default and keeps the behaviour of pi-qq 1.5.x; thinking is always relayed in this mode.
- `simple` streams every assistant message live, one QQ bubble per message.
- Model errors are always delivered immediately as a normal message, in either mode.
- Tool output is not relayed in `simple`, but files sent with `qq_send_media` are still delivered.
- While a task is running, `/last` pushes the current thinking/tools/text snapshot in `full` mode; in `simple` mode it pushes the current text.

### `deliverAs`

How a QQ message reaches pi while a task is already running.

- `steer` (default): the message is injected into the running task at the next safe point.
- `followUp`: the message is queued and processed after the running task finishes.

### `fileMaxSize`

Maximum size of an inbound attachment, in bytes (default `52428800`, 50MB). Larger files are rejected with a notice instead of being downloaded, which keeps the local disk and the download quota under control.

### `language`

Language of UI notifications and replies. Log files are always written in English, regardless of this setting.

- `zh-cn` (default): Simplified Chinese.
- `en-us`: English.

### `logLevel`

Log threshold. Records are written only while a QQ-triggered run is active after login, to `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`; `PI_QQ_LOG_DIR` overrides the directory. `scope: "media"` covers media-tool steps during those runs.

- `silent` (default): no log file at all.
- `error`: failures only.
- `warn`: failures and recoverable problems.
- `info`: run metadata as well — message ids, content lengths, agent start and end.
- `debug`: everything, including tool arguments and results, attachment metadata, prompts, and raw voice transcripts.

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
- QQ limits passive replies per inbound message. Use `/qq-test-budget` to inspect the local budget.
- Reading a `SKILL.md` is shown as a `## 🧩 Skill` block with the skill name; the file content is not forwarded to QQ.

## License

MIT
