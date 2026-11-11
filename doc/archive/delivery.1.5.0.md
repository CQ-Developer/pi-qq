# pi-qq delivery-v5

> **Delivery record.** v5 adds outbound media delivery and fixes debug log coverage for non-QQ runs. See [README](../../README.md) for current user-facing behavior.
> Version: 1.5.0
> Date: 2026-11-05
> Previous: [delivery.1.0.0.md](./delivery.1.0.0.md), [delivery.1.2.0.md](./delivery.1.2.0.md), [delivery.1.3.0.md](./delivery.1.3.0.md), [delivery.1.4.0.md](./delivery.1.4.0.md).
> Supersedes: `doc/research.md`, `doc/feature.md`, and `doc/plan.md`; those working documents were consolidated into this record and removed.
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

v5 closes the gap where a remote QQ user could not see generated images, videos, or files. It adds one LLM-facing tool, `qq_send_media`, and tightens debug logging so local runs are diagnosable too.

In scope:

- send local images, videos, and files to the bound QQ private chat;
- activate the tool after QQ login and deactivate it on logout;
- passive-first delivery with proactive fallback;
- size/type validation before upload;
- normal tool bubble for calls and results;
- debug logs for the media lifecycle and for local/logged-out runs.

Out of scope:

- inbound intent parsing or keyword matching;
- a second confirmation step before sending;
- voice messages;
- URL-based media sources;
- multiple files per tool call;
- path-root restrictions.

## 2. Final decisions

| Topic                | Decision                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Call timing          | The model decides from the tool `description` and `promptGuidelines`. No inbound parser, no keyword list, no confirmation step.                                          |
| Activation           | Registered inactive at startup (`defaultActive: false`). Activated by `startWithCredentials()` after QQ login. Deactivated by `stopIfRunning()` on logout/stop/shutdown. |
| Reconnect            | Login state is the switch, not connection state. Reconnecting does not deactivate the tool; `execute()` errors if the bot is not ready.                                  |
| Paths                | Any readable regular file is allowed. Symlinks, directories, devices, and empty files are rejected.                                                                      |
| Media kind           | `auto` by default: images/videos by extension, everything else as `FILE`. Explicit `kind` can override; audio is sent as a file.                                         |
| Tool bubble          | Same as any other tool: `## 📤 qq_send_media`; no suppression, no custom renderer.                                                                                       |
| Configuration        | No new settings.                                                                                                                                                         |
| Runtime dependencies | None added. `typebox` is supplied by pi.                                                                                                                                 |

The trade-off is explicit: “only call when the user asks” is a model-level instruction, not a hard gate. The tool being inactive before login is a real gate; the per-call decision is not.

## 3. Tool surface

```ts
const mediaParams = Type.Object({
  path: Type.String({ description: "Local image/video/file path, absolute or relative to cwd." }),
  kind: Type.Optional(StringEnum(["auto", "image", "video", "file"] as const)),
  caption: Type.Optional(Type.String({ description: "Optional caption shown with the media." })),
  name: Type.Optional(Type.String({ description: "Display filename for kind=file." })),
});
```

- `path`: local source; leading `@` is stripped; relative paths resolve from `ctx.cwd`.
- `kind`: `auto` by default; `image`/`video` require a matching extension; `file` always uses `MediaFileType.FILE`.
- `caption`: optional QQ media-message `content`, displayed with the image/video/file in one bubble. Truncated to 4500 characters.
- `name`: optional display filename for `FILE` only; passed as `fileName` to the SDK. Images/videos do not use it.

Tool metadata:

- `defaultActive: false`
- `executionMode: "sequential"`
- `promptSnippet`: one-line tool entry in the system prompt.
- `promptGuidelines`: call only on an explicit user request, never proactively after generating a file, ask when unsure.

## 4. Lifecycle

```text
[*] --> Inactive: startup / defaultActive=false
Inactive --> Active: QQ login / startWithCredentials()
Active --> Inactive: logout / stopIfRunning()
Active --> Active: reconnect (state unchanged)
```

- `registerMediaTool()` registers the tool once at extension load.
- `startWithCredentials()` calls `activate()` after the bot starts.
- `stopIfRunning()` calls `deactivate()`; covers `/qq-logout`, `/qq-login` restart, and `session_shutdown`.
- `activate()`/`deactivate()` preserve all other active tools and are idempotent.
- No `onStateChange` wiring: login, not transient connection state, controls availability.

## 5. Send flow

1. Validate the path with `lstat`.
2. Resolve `MediaFileType` and check `getMaxUploadSize()`.
3. Upload with `bot.uploadMedia({ localPath, fileType, fileName, srvSendMsg: false })`.
4. Pick a reply target with `ReplyBudget.acquire()`.
5. Send with `bot.mediaApi.sendMediaMessage()`, passing `msgId` for passive replies.
6. Commit the passive reply after success.
7. On passive failure, reuse the existing `file_info` for one proactive retry; never re-upload.

Type limits:

| Type  |    Max |
| ----- | -----: |
| Image |  30 MB |
| Video | 100 MB |
| File  | 100 MB |

- Files ≥5 MB use the SDK chunked-upload path automatically.
- Only passive sends call `commitPassive()`.
- The tool is `executionMode: "sequential"` to avoid parallel passive-quota races.
- `signal.aborted` is checked at entry and after upload.

## 6. Debug logging

All new logs use `scope: "media"`; they are written only when `logLevel: "debug"`.

Key points:

| Point                   | Fields                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Tool registration       | `defaultActive`                                                                                 |
| Activation/deactivation | `active`, `removed`, `activeCount`                                                              |
| Call entry              | `toolCallId`, `path`, `kind`, `captionLength`                                                   |
| Validation              | `fileType`, `sizeBytes`, `displayName`; failure includes `reason`                               |
| Upload                  | start: `fileType`, `sizeBytes`, `path`; done: `fileUuid`, `ttlSec`, `elapsedMs`                 |
| Budget                  | `mode`, `msgId`, `remaining`, `fresh`                                                           |
| Send                    | start: `mode`, `targetId`, `msgId`, `fileType`, `captionLength`; done: `messageId`, `elapsedMs` |
| Failure                 | raw `err` for upload, passive send, and proactive retry                                         |

Logs never include file contents, base64, raw `file_info`, or caption text.

### 6.1 Debug log bugfix

Before v5, `message_end` returned early when `running` was unset, before writing its debug log. As a result, assistant-message debug logs only appeared after QQ login. v5:

- moves the `message_end` debug log before the `!running` / `!fromQQ` guard;
- adds `fromQQ`, `hasBot`, `hasLogin` to assistant and agent run markers;
- keeps `src/relay/` stream logs QQ-specific; local runs do not fabricate relay logs;
- keeps `silent` as the default.

## 7. Tool bubble

No special handling:

- `RunFeedback` forwards `tool_execution_start` / `tool_execution_end` as usual.
- `TOOL_ICONS` adds `qq_send_media: "📤"`.
- The result text is concise and localized; the full message id stays in `details` and logs.
- The media message is separate from the tool bubble; both appear in QQ.

## 8. Code map

| File                               | Change                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `src/qq/media-tool.ts`             | Tool schema, validation, upload/send, activation controller, debug logs |
| `index.ts`                         | Register tool, activate on login, deactivate on stop, debug log fix     |
| `src/infra/i18n.ts`                | Media messages and localized media kinds                                |
| `src/relay/stream-block-format.ts` | `📤` tool icon                                                          |
| `test/qq/media-tool.test.ts`       | Tool behavior and error mapping                                         |
| `test/index.test.ts`               | Lifecycle, debug logs, activation                                       |
| `test/infra/i18n.test.ts`          | Media message localization                                              |
| `README.md` / `README-zh.md`       | User-facing usage                                                       |
| `CHANGELOG.md`                     | v5 release notes                                                        |

## 9. Verification

Real QQ test log: `/home/chen/project/pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-05.log`.

| Case                         | Result                                                                |
| ---------------------------- | --------------------------------------------------------------------- |
| 6 MB image, `kind:image`     | `fileType:1`, chunked upload 3.3s, passive send 1.5s                  |
| 25 MB image, `kind:image`    | `fileType:1`, chunked upload 6.9s, passive send 0.88s                 |
| 31 MB image, `kind:image`    | Local reject: 31.2 MB > 30 MB                                         |
| H.264 MP4, `kind:video`      | `fileType:2`, upload 1.3s, passive send 0.98s                         |
| 1 MB ZIP, `kind:file`        | `fileType:4`, passive send success                                    |
| 101 MB file, `kind:file`     | Local reject: 101 MB > 100 MB                                         |
| 4 passive sends + final text | Budget exhausted; later sends fell back to proactive and succeeded    |
| Tool bubble                  | `## 📤 qq_send_media` with args/result; media message separate        |
| Debug logs                   | call/validate/upload/budget/send/result present; no unexpected errors |

Automated checks:

- **194 tests passed** across 19 files.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run format:check` passed.
- `npm pack --dry-run` passed.

Not covered by the acceptance run:

- HEVC/H.265 video as a native video message (H.264 was used);
- upload daily quota;
- a bot without file-message permission;
- upload cancellation;
- retry duplicate-send behavior;
- proactive-message quota boundary.

## 10. Risks and limitations

- The “call only when asked” rule is a soft model constraint. The model can still call the tool without an explicit request; this is accepted.
- The tool is available in local sessions after login. This follows the login-level activation decision.
- Any readable file can be sent; the model already has local read access, so path restriction is not a security boundary.
- Media and final text share the passive-reply budget. Heavy media use can push the final text to proactive delivery.
- `caption` and `name` are model-decided; pi-qq does not validate their intent.
- Reconnect does not deactivate the tool; calls can fail while the bot is not ready.
- Large uploads block the tool until finished; the SDK has no upload abort signal.

## 11. Open items

- `doc/todo.md` item 1: long-running bash argument/tool-start visibility.
- `doc/todo.md` item 2: long-running tools leading to missing QQ output.
- Verify HEVC video as `VIDEO` if that format matters.
- Verify no-file-permission behavior and the large-file upload daily quota.
- Decide whether the tool description should explicitly prefer `kind=auto` unless the user asks for a file.

The v5 acceptance log does not cover the two long-running bash scenarios; they remain separate TODO items.

## 12. References

- Design history: [delivery.1.4.0.md](./delivery.1.4.0.md).
- User-facing behavior: [README.md](../../README.md), [README-zh.md](../../README-zh.md).
- QQ SDK: `@tencent-connect/qqbot-nodejs` 1.0.5, `src/QQBot.ts`, `src/protocol/api/media.ts`.
- pi extension API: `pi/packages/coding-agent/docs/extensions.md`.
- Release commits:
  - `c360c70` — research/design docs;
  - `a0e4d93` — implementation plan;
  - `8528d4f` — `qq_send_media` and debug logging;
  - `62f82db` — avoid action calls during extension loading;
  - `39cd540` — polish media result text;
  - `v1.5.0` — release tag.
