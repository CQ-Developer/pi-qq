# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.2] - 2026-11-11

### Changed

- While a task is running in `replyType: "full"`, `/last` now pushes the current thinking, tools, and text snapshot to the new message immediately instead of waiting for assistant text. If the stream was dead, the repush opens a new stream and resumes later output. An empty snapshot now replies with a notice instead of staying silent.
- Log files are now always written in English; the `language` setting only affects UI notifications and replies.
- Consolidated the 1.6.2 code review and repair notes into `doc/archive/delivery.1.6.2.md`; removed the temporary `doc/repair.md`.

### Removed

- Removed `replyType: "last"`; the only modes are now `full` and `simple`. Existing `"last"` values fall back to `full` with a validation warning.

### Fixed

- Stream rate-limit retries now advance `index` and recognize QQ `ApiError` HTTP/business codes.
- A `40054005` duplicate-`msgseq` error now opens a new stream with a fresh sequence and replays the buffered content instead of repeatedly resuming the failed stream.
- Empty attachment responses are rejected consistently.

## [1.6.1] - 2026-11-11

### Changed

- Settings are loaded when the extension starts and re-read on every inbound QQ message from the bound user, so edits to `pi-qq.json` take effect on the next message without restarting pi or logging in again. Config errors are reported once per distinct text.

### Removed

- Removed the `thinkingRelay` setting. `replyType: "full"` now always relays thinking, while `simple` and `last` never do. Existing `thinkingRelay` keys are ignored.

## [1.6.0] - 2026-11-09

### Added

- Added the `replyType` setting to control how much of an agent run is pushed to QQ: `full` (thinking, tool calls, and tool results), `simple` (assistant messages only, one bubble each), or `last` (only the last assistant message, delivered when the run ends). The default is `full`, so the default behaviour is unchanged; set `"replyType": "simple"` or `"last"` to push less to QQ.
- Added the effective reply type to `/qq-status`.

### Changed

- In `last` mode, `/last` during a running task now replies that the task is still running instead of repushing partial output.
- Consolidated the v6 design and delivery record into `doc/archive/delivery.1.6.0.md`; removed the working document.

### Fixed

- The `last` reply mode now records its delivery result (`last delivered`) in the debug log before the run state is cleared, so the record is no longer dropped by the QQ-run log gate.
- Bubbles that pass 12k characters are now split at the next line break found in the incoming text chunk. Previously the split only happened when a chunk happened to end with a newline, which almost never occurred, so long messages were split by the platform instead and thinking blocks lost their repeated heading.

## [1.5.1] - 2026-11-05

### Changed

- Logs are now written only during QQ-triggered runs after login. Local runs, login/QR flows, bot lifecycle events, and idle periods no longer create log files.

## [1.5.0] - 2026-11-05

### Added

- Added the `qq_send_media` tool for sending local images, videos, and files back to the bound QQ private chat. The tool is registered inactive and activates after QQ login.
- Added `scope: "media"` debug logs for registration, activation, validation, upload, budget selection, send, and result.

### Changed

- Consolidated the v5 research, feature, and implementation plan into `doc/archive/delivery.1.5.0.md`; removed the three working documents.

### Fixed

- Debug logs for local and logged-out sessions: assistant message and agent lifecycle events are now logged even when no QQ run is active. QQ relay logs remain specific to QQ-triggered runs.
- Avoided action-method calls during extension loading when registering the media tool.
- Localized media result labels and removed the long message id from the user-facing tool result.

## [1.4.2] - 2026-11-05

### Changed

- Thinking bubbles now start with the `## 💭 <label>` heading, matching the `##` heading syntax used by tool and skill blocks.
- The English `en-us` thinking label is now `Thinking` instead of `思考`.
- Skill blocks are localized: `## 🧩 Skill` in `en-us` and `## 🧩 技能` in `zh-cn`.

## [1.4.1] - 2026-11-04

### Changed

- Removed the archived Chinese delivery records from `doc/archive/` and dropped `doc/archive/README.md`.
- Removed code comments from the TypeScript sources, tests, configuration, and release workflow.

## [1.4.0] - 2026-11-04

### Added

- Debug diagnostics for long-running tools: tool duration/update summaries, stream frame error codes, writer state, `/last` repush, `/stop` wait time, and event-loop timer drift. Logging only; no runtime behavior change.

### Changed

- Tool bubbles now use `## <icon> <name>`, show `bash` commands in a `bash` code block without truncation, and choose result code-block languages from `read` file extensions (for example `markdown`, `python`, `json`).
- Consolidated the v4 design and investigation records into `doc/archive/delivery.1.4.0.md` and `doc/archive/delivery-v4-zh.md`.

## [1.3.6] - 2026-11-04

### Added

- Debug timing logs for tool stream enqueue/append, stream buffer/flush timers, and event-loop delay. They are written only at `logLevel: "debug"` and do not change runtime behavior.

## [1.3.5] - 2026-11-04

### Added

- Reading a `SKILL.md` now renders a dedicated `## 🧩 Skill` block on QQ instead of a generic read tool; the file content is not forwarded.

## [1.3.4] - 2026-11-04

### Added

- `/status` now shows agent state, connection state, model/context, QQ user, battery (when available), and icons.
- `language` setting for `zh-cn` / `en-us`; user-facing text and logs are localized.
- Stable `msgKey` in structured logs for language-independent filtering.

### Changed

- Default language is `zh-cn`.

## [1.3.3] - 2026-11-04

### Added

- QQ `/last` command: push the last completed assistant message as a new stream bubble, or restart the current output while a run is active.

## [1.3.2] - 2026-11-04

### Added

- GitHub Releases now attach the npm tarball and a `SHA256SUMS` file.

### Changed

- Log records are written asynchronously, and debug payload previews are only built when debug logging is enabled.
- Historical delivery records moved to `doc/archive/` and are marked unmaintained.
- Relay composition and inbound command/attachment handling were split into smaller modules for maintainability.

## [1.3.1] - 2026-11-04

### Added

- CI workflow for pushes and pull requests.
- Regression coverage for session lifecycle, mixed voice attachments, and image handling.
- Automated release notes sourced from this changelog.

### Changed

- Images now use the same save/pending pipeline as files. The next instruction reads them through pi's `read` tool.
- Attachment prompts use workspace-relative paths and the concise `# Attachments:` / `# User message:` format.
- Settings are validated and resolved once per session. `fileMaxSize` now applies to all attachments; `imageMaxSize` was removed.
- README rewritten for users and developers.

### Fixed

- Invalid config shapes such as `null` or arrays no longer crash startup.
- Cancelling QR login no longer reports a failure.
- `/stop` clears model-error recovery even when idle.
- Login/logout and session shutdown dispose the active relay.
- Voice messages preserve other attachments in the same message.
- `chunkText` no longer loops forever on an invalid limit.

### Security

- The bot now requires a bound openid and always installs an allowlist.

## [1.3.0] - 2026-11-03

### Changed

- Reworked relay output into per-content-block streamed bubbles.
- Added thinking labels, per-tool icons, model-error recovery, and idle-safe session handling.
- Reorganized modules by bounded context and updated settings and delivery documentation.

[Unreleased]: https://github.com/CQ-Developer/pi-qq/compare/v1.6.2...HEAD
[1.6.2]: https://github.com/CQ-Developer/pi-qq/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/CQ-Developer/pi-qq/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/CQ-Developer/pi-qq/compare/v1.5.1...v1.6.0
[1.5.1]: https://github.com/CQ-Developer/pi-qq/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/CQ-Developer/pi-qq/compare/v1.4.2...v1.5.0
[1.4.2]: https://github.com/CQ-Developer/pi-qq/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/CQ-Developer/pi-qq/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.6...v1.4.0
[1.3.6]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.5...v1.3.6
[1.3.5]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.4...v1.3.5
[1.3.4]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/CQ-Developer/pi-qq/compare/v1.2.3...v1.3.0
