# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.1] - 2026-11-04

### Changed

- Removed the archived Chinese delivery records from `doc/archive/` and dropped `doc/archive/README.md`.
- Removed code comments from the TypeScript sources, tests, configuration, and release workflow.

## [1.4.0] - 2026-11-04

### Added

- Debug diagnostics for long-running tools: tool duration/update summaries, stream frame error codes, writer state, `/last` repush, `/stop` wait time, and event-loop timer drift. Logging only; no runtime behavior change.

### Changed

- Tool bubbles now use `## <icon> <name>`, show `bash` commands in a `bash` code block without truncation, and choose result code-block languages from `read` file extensions (for example `markdown`, `python`, `json`).
- Consolidated the v4 design and investigation records into `doc/archive/delivery-v4.md` and `doc/archive/delivery-v4-zh.md`.

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

[Unreleased]: https://github.com/CQ-Developer/pi-qq/compare/v1.4.1...HEAD
[1.4.1]: https://github.com/CQ-Developer/pi-qq/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.6...v1.4.0
[1.3.6]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.5...v1.3.6
[1.3.5]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.4...v1.3.5
[1.3.4]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/CQ-Developer/pi-qq/compare/v1.2.3...v1.3.0
