# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/CQ-Developer/pi-qq/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/CQ-Developer/pi-qq/compare/v1.2.3...v1.3.0
