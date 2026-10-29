# pi-qq

Connect [pi](https://github.com/earendil-works/pi) to a QQ private chat. Send text, images, or files from mobile QQ; pi works on your machine and sends the result back to QQ.

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
- **Images**: sent to pi as vision input.
- **Files**: saved under the current workspace at `.pi/pi-qq/YYYY-MM-DD/<msgId>/`; the saved path, size, and original filename are added to the prompt.

Example file prompt seen by pi:

```text
User sent the following file via QQ (saved locally; use read/bash or other tools to access it):
- /home/chen/project/myproj/.pi/pi-qq/2026-10-29/xxx/report.pdf (1.4MB, original name: report.pdf)

User message:
Summarize this file.
```

## Commands

Run these in the pi terminal:

| Command | Description |
| --- | --- |
| `/qq-login` | Log in with a QR code and bind the scanning QQ user |
| `/qq-status` | Show login, connection, model, context, and bound user |
| `/qq-logout` | Log out and clear in-memory credentials |
| `/qq-budget` | Show passive-reply budget and stream-bubble diagnostics |
| `/qq-md [text]` | Send a Markdown test message |
| `/qq-stream-test` | Run a streamed timeline diagnostic |
| `/qq-new` | Reset the current session (used by QQ `/new`) |

QQ-side commands:

| Command | Description |
| --- | --- |
| `/new` | Start a new pi session |
| `/stop` | Abort the current run |
| `/compact` | Compact the current context |
| `/status` | Show session and usage status |
| `/help` | Show command help |

## Settings

Create `~/.pi/agent/pi-qq.json` to override defaults. This file contains settings only; credentials are never written to it.

```json
{
  "markdownSupport": false,
  "streamFlushMs": 10000,
  "debug": false
}
```

| Key | Default | Description |
| --- | --- | --- |
| `streamAssistant` | `true` | Stream assistant replies |
| `markdownSupport` | `false` | Bot has QQ Markdown permission; pass Markdown through |
| `usageRelay` | `true` | Send the per-run usage summary |
| `deliverAs` | `"steer"` | Queue new messages while busy: `steer` or `followUp` |
| `imageMaxSize` | `10485760` | QQ image download limit in bytes (10MB) |
| `fileMaxSize` | `52428800` | QQ file download limit in bytes (50MB) |
| `heartbeatMinutes` | `10` | Long-task heartbeat interval; `0` disables |
| `heartbeatMaxMessages` | `3` | Per-run message heartbeat limit |
| `streamRelay` | `true` | Use append-mode stream bubbles |
| `streamFlushMs` | `10000` | Stream summary frame interval in ms (minimum 300) |
| `debug` | `false` | SDK and stream retry/timeout diagnostics |

## Notes

- Only C2C (QQ private chat) is supported.
- Incoming images are passed to the model as vision input; the current model must support image input.
- Saved files are workspace-local under `.pi/`; add `.pi/` to your own project `.gitignore` if needed.
- QQ limits passive replies per inbound message. Use `/qq-budget` to inspect the local budget.

## License

MIT
