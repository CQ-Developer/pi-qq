# pi-qq delivery 1.6.1

> **Delivery record.** 1.6.1 reloads `pi-qq.json` before every inbound QQ message and removes the redundant `thinkingRelay` setting. See [README](../../README.md) for current user-facing behavior.
> Version: 1.6.1
> Date: 2026-11-11
> Previous: [delivery.1.6.0.md](./delivery.1.6.0.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

Before 1.6.1, `~/.pi/agent/pi-qq.json` was read when the extension loaded, on `session_start`, and on `/qq-login`. Editing the file while the bot was running required a restart or a new login.

1.6.1 changes the trigger points and removes one setting:

- reload configuration before handling every inbound QQ message from the bound user;
- keep one initialization read at extension load for static command descriptions and early i18n;
- remove the `session_start` and `/qq-login` reads;
- remove `thinkingRelay`; `replyType` becomes the only output-mode control.

In scope:

- a single `applyConfig()` path for reading and applying the file;
- per-message reload in `createInboundHandler()`;
- logger setup when the bot starts and on each reload;
- initial config errors reported at `session_start`;
- deduplication of repeated QQ-message config errors;
- removal of `thinkingRelay` from settings, relay code, i18n, tests, and READMEs.

Out of scope:

- file watching or reloading configuration without a new QQ message;
- restarting the QQ bot or re-running QR login on a config change;
- changing `replyType` modes or their relay policies;
- migrating local (non-QQ) runs to a new reload trigger.

## 2. Final decisions

| #   | Question                                                   | Decision                                                                                                                                                 |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | When is the config file read?                              | At extension load and before every inbound QQ message from the bound user.                                                                               |
| D2  | Why keep the extension-load read?                          | Command descriptions and other static UI strings are registered before `session_start`, so `language` must be applied there.                             |
| D3  | Should `session_start` or `/qq-login` read the file again? | No. They reuse the latest initialized or reloaded values; `session_start` only reports the error captured at extension load.                             |
| D4  | Should a reload restart the bot?                           | No. It replaces in-memory settings, i18n, and logger configuration only. Credentials and the QQ connection stay intact.                                  |
| D5  | What happens with an invalid file?                         | Valid fields are kept, invalid fields and parse failures fall back to defaults, and an error is reported. Identical QQ-message errors are reported once. |
| D6  | Should `thinkingRelay` stay?                               | No. `replyType: "full"` always relays thinking; `simple` and `last` never do. Existing `thinkingRelay` keys are ignored.                                 |

## 3. Trigger points

| Event                  | Before 1.6.1               | 1.6.1                                                           |
| ---------------------- | -------------------------- | --------------------------------------------------------------- |
| Extension load         | Read                       | Read (initialization)                                           |
| `session_start`        | Read                       | No read; uses initialized values and reports the captured error |
| `/qq-login`            | Read                       | No read; uses current values                                    |
| Inbound QQ message     | No read                    | Read and apply (reload)                                         |
| When edits take effect | After restart or new login | On the next QQ message                                          |

```text
QQ message
  -> qqbot filtering, access policy, concurrency guard
  -> createInboundHandler
  -> bound-user check
  -> reloadSettings()
       readConfig()
       getSettings()
       configureI18n()
       configureLogger()
  -> command or normal message handling
  -> markQQTrigger() / sendUserMessage()
```

The reload runs before attachment downloads, message injection, and replies, so the current message already uses the new `fileMaxSize`, `deliverAs`, `language`, `logLevel`, and `replyType`.

Local runs started directly in pi use the latest initialized or reloaded values. Pi reloads extensions for `new`, `resume`, and `fork`, so those flows run the initialization read again.

## 4. Settings

| Key           | Effect after reload                                                        |
| ------------- | -------------------------------------------------------------------------- |
| `fileMaxSize` | Applied to attachments in the current inbound message                      |
| `deliverAs`   | Applied when the current message is injected into pi                       |
| `language`    | Applied to subsequent notifications, replies, and log text                 |
| `logLevel`    | Applied to subsequent log writes; the QQ-run log gate is unchanged         |
| `replyType`   | Applied to subsequent relay decisions, including a run already in progress |

A run that is already executing without a new QQ message keeps the previous values.

### 4.1 Logging

- The extension-load read has no session `cwd`, so it does not configure logging.
- `startWithCredentials()` configures the log path and level from `activeSettings` when the bot starts.
- A QQ-message reload applies the latest `logLevel` immediately.
- Logs are still written only while a QQ-triggered run is active after login.

### 4.2 Invalid configuration

- Missing file: all defaults, no error.
- Invalid JSON root or parse failure: defaults, with an error.
- Invalid individual fields: valid fields are kept, invalid fields are ignored, with an error.
- The error captured at extension load is shown once at `session_start`.
- QQ-message reloads report new errors; identical error text is deduplicated until the config is fixed.
- `/qq-login` does not re-read the file, so it does not produce a new parse-error notification.

## 5. `thinkingRelay` removal

`thinkingRelay` was a sub-option of `replyType: "full"`. Removing it leaves `replyType` as the only output-mode control:

- `full` relays thinking as before.
- `simple` and `last` never relay thinking.

Existing `"thinkingRelay": false` entries are ignored; they no longer suppress thinking in `full` mode. Users who want no thinking must choose `simple` or `last`, which also disable tool output. A "tools but no thinking" combination would require a new `replyType` mode and is not part of 1.6.1.

## 6. Implementation

| File                                  | Change                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                            | Single `applyConfig()`; error deduplication; initial error captured for `session_start`; `startWithCredentials()` configures logging; removed `getThinkingRelay`; removed `session_start` and `/qq-login` reads |
| `src/qq/qq-message-handler.ts`        | Added `InboundDeps.reloadSettings` and call it after the bound-user check                                                                                                                                       |
| `src/infra/settings.ts`               | Removed `thinkingRelay` parsing, validation, and defaulting                                                                                                                                                     |
| `src/relay/run-stream-relay.ts`       | Thinking relay now depends only on the `replyType` policy                                                                                                                                                       |
| `src/infra/i18n.ts`                   | Removed the `settings.thinkingRelay` error text                                                                                                                                                                 |
| `test/index.test.ts`                  | Per-message reload, changed `deliverAs`, initial error display, and error deduplication                                                                                                                         |
| `test/qq/qq-message-handler.test.ts`  | Reload happens before settings are read                                                                                                                                                                         |
| `test/infra/settings.test.ts`         | Removed `thinkingRelay` expectations; legacy key is ignored                                                                                                                                                     |
| `test/relay/run-stream-relay.test.ts` | Removed the `thinkingRelay` harness option and test                                                                                                                                                             |

## 7. Verification

- **226 tests passed** across 19 files.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm pack --dry-run` passed.
- The test suite covers:
  - a config read before every handled QQ message;
  - a `deliverAs` change between two messages taking effect on the second;
  - `session_start` reporting the initialization error without another read;
  - identical QQ-message config errors being reported once;
  - the legacy `thinkingRelay` key being ignored.

## 8. Risks and limitations

| Risk                                            | Impact                                                              | Handling                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Configuration is not watched                    | An edit without a new QQ message is not applied to a running task   | Reload is intentionally tied to the next QQ message                                     |
| `/qq-login` and local status use startup values | A mid-session edit is not reflected there until the next QQ message | Accepted; QQ conversations use the fresh values                                         |
| `thinkingRelay` removal                         | `"thinkingRelay": false` users now receive thinking in `full` mode  | Documented in the CHANGELOG and READMEs; choose `simple` or `last` to suppress thinking |
| Config errors are deduplicated                  | Repeating the same invalid config does not pop a new warning        | The error is shown once at load and once per distinct text during message reloads       |

## 9. References

- User-facing behavior: [README.md](../../README.md), [README-zh.md](../../README-zh.md).
- Previous delivery: [delivery.1.6.0.md](./delivery.1.6.0.md).
- This record replaces the temporary configuration-timing note; that note was removed with the release.
