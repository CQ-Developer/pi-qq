# pi-qq delivery-v2

> **Archived record.** Content reflects the delivery at that time and may reference removed modules or settings. See [README](../../README.md) for current behavior.
> Status: v2 delivered; this is a historical record.
> Previous: [delivery-v1.md](./delivery-v1.md); next: [delivery-v3.md](./delivery-v3.md).

## 1. Scope

v2 adds to v1's QQ chat, image, and file support:

- F8 voice-message transcription;
- F9 structured logging;
- F10 file-only messages waiting for the next instruction;
- F11 upload paths, index, and deduplication.

## 2. Features

### F8 Voice messages

- Use QQ built-in ASR (`asr_refer_text`); never download the audio.
- Send the transcript to pi as ordinary user text.
- If ASR returns no text, reply `Could not transcribe this voice message; please resend or type it.` and do not start a run.
- No local or external speech-to-text service is used.
- Raw ASR results and attachment metadata are only written at `debug` level.

### F9 Logging

- Write daily files to `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`.
- `PI_QQ_LOG_DIR` can override the directory.
- Thresholds: `silent`, `error`, `warn`, `info`, `debug`.
- `info` records metadata only; `debug` records full events, attachments, prompts, and tool payloads.
- Logs are JSONL; errors include name, message, and stack.
- Legacy `debug: true` maps to `logLevel: "debug"`.

### F10 File-only messages

- A file-only message does not start pi; the file is saved and becomes pending.
- The next text or voice instruction consumes pending files and includes paths, sizes, and original filenames in the prompt.
- Multiple files uploaded before an instruction are merged into one prompt.
- `/new` clears pending files.
- Pending files are scoped to the current pi session.

### F11 Upload storage and deduplication

- Saved under the current workspace at `.pi/pi-qq/<sessionId>/uploads/`.
- Same name and same content reuses the existing file.
- Same name and different content is saved as `name-1.ext`.
- Different names with identical content are saved separately.
- The index maps filenames to hashes only; paths and sizes come from the filesystem. Stale index entries are pruned on startup.
- Pending files are independent from the index; `/new` does not delete saved indexed files.

## 3. Settings

| Setting         | Default        | Description                 |
| --------------- | -------------- | --------------------------- |
| `thinkingRelay` | `true`         | Relay thinking text         |
| `deliverAs`     | `"steer"`      | Queue behavior while busy   |
| `imageMaxSize`  | 10MB           | Image download limit        |
| `fileMaxSize`   | 50MB           | File download limit         |
| `logLevel`      | `"silent"`     | Log threshold               |
| `debug`         | migration only | Legacy log switch migration |

## 4. Modules and boundaries

<!-- prettier-ignore -->
| Module                       | Responsibility                                                |
| ---------------------------- | ------------------------------------------------------------- |
| `src/qq/qq-message-handler.ts`  | Unified voice/file/text inbound routing; command interception |
| `src/attachments/voice-transcript.ts`    | ASR text extraction and availability                          |
| `src/attachments/file-attachments.ts`    | File storage, hashes, index, pending-file prompt              |
| `src/attachments/attachment-download.ts` | Shared download limits for images and files                   |
| `src/attachments/image-attachments.ts`   | Image validation and vision input assembly                    |
| `src/infra/file-logger.ts`         | Log levels, formatting, daily file output                     |
| `src/qq/reply-sender.ts`        | Markdown conversion, chunking, sending                        |
| `src/quota/reply-quota.ts`         | Passive reply quota                                           |

Boundary rules:

- `qq-message-handler` only routes; it does not implement download or storage details.
- `voice-transcript` never touches the filesystem.
- `file-attachments` handles storage and indexing, not pi events.
- `file-logger` does not depend on business modules.
- All attachment downloads go through `attachment-download.ts` so timeouts and size limits do not diverge.

## 5. Verification

- Voice ASR text injection, empty-ASR prompting, and no audio persistence.
- File-only messages do not start a run; the next instruction consumes the files.
- Multiple pending files merge; `/new` clears pending files.
- Same-name/same-content reuse, same-name/different-content suffixing, and different-name/same-content separation.
- Log directory, levels, JSONL fields, and legacy `debug` migration.
- Automated tests and real QQ verification passed.

## 6. Known limitations

- Only QQ ASR is used; there is no local speech-recognition fallback.
- If ASR returns no text, the user must resend or type the message.
- Pending files are scoped to the current pi session.
- `debug` logs can contain sensitive tool payloads and file contents; enable only while troubleshooting.
