# pi-qq 出站媒体工具调研

- 调研对象：pi 1.5.0（`/home/chen/project/pi`）、`@tencent-connect/qqbot-nodejs` 1.0.5（`/home/chen/project/qqbot-nodejs`）、pi-qq 1.4.2（`/home/chen/project/pi-qq`）
- 目标：新增一个 pi 工具，让模型把本地图片、视频或文件发回当前 QQ 私聊，解决手机 QQ 上无法查看最终效果的问题。
- 结论：**可行，且不需要修改 QQ SDK**。SDK 已经提供 C2C 媒体上传/发送能力，pi 扩展可以注册自定义工具；pi-qq 只需要补一层工具、目标选择、配额记账和降级逻辑。

## 1. 结论与建议

推荐实现：

1. 在 pi-qq 中注册一个自定义工具 `qq_send_media`，参数为本地路径、可选类型、可选说明文字、可选文件名。
2. 先调用 `bot.uploadMedia()` 上传，拿到 `file_info`；再用 `bot.mediaApi.sendMediaMessage()` 发送。**不要直接调用 `sendImage`/`sendVideo`/`sendFile`**，因为两步式可以在被动回复失败后复用已上传的 `file_info` 降级为主动消息，避免重复上传。
3. 复用 pi-qq 的 `ReplyBudget`：优先被动回复，超过 4 次或窗口过期后降级主动消息；发送成功后 `commitPassive()`。
4. 工具设置 `executionMode: "sequential"`，避免同一轮里多个媒体调用并发抢被动回复额度。
5. 在工具层面做类型识别和大小校验，因为 SDK 高层 API 不校验每种媒体的上限。

主要风险：QQ 每条入站消息只有 4 次被动回复、分块上传有日额度、文件消息可能需要额外权限、视频编码/格式由平台校验、媒体消息和流式气泡的先后顺序需要实测。

---

## 2. pi 扩展侧：自定义工具机制

### 2.1 注册方式

`pi.registerTool()` 可以在扩展加载时调用，也可以在 `session_start`、命令处理器等时机调用；注册后立即出现在工具列表中，并默认激活。参考 `pi/packages/coding-agent/docs/extensions.md:1586`。

工具定义的关键字段（`pi/packages/coding-agent/src/core/extensions/types.ts:599`）：

| 字段               | 作用                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| `name`             | 模型调用的工具名                                                          |
| `label`            | TUI 显示名                                                                |
| `description`      | 给模型看的说明                                                            |
| `parameters`       | TypeBox 参数 schema，必须是 object schema                                 |
| `promptSnippet`    | 加入系统提示词 `<tools>` 段的一行摘要；不填则不会出现在该段               |
| `promptGuidelines` | 加入 `<rules>` 段的规则；每条必须明确写出工具名                           |
| `executionMode`    | `"sequential"` 可让该工具与其他工具串行执行                               |
| `execute`          | `(toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>` |

工具结果结构（`pi/packages/agent/src/types.ts:424`）：

```ts
{
  content: (TextContent | ImageContent)[];
  details: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}
```

`content` 是给模型的；`details` 给 UI/日志。工具失败可以抛错，也可以返回 `isError: true`。参数 schema 建议从 `typebox` 导入 `Type`，这是 pi 宿主提供的模块，`pi` 文档明确说不要把它列进 `dependencies`（`extensions.md:161-170`）。

### 2.2 工具草图

```ts
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const mediaParams = Type.Object({
  path: Type.String({ description: "Local image/video/file path." }),
  kind: Type.Optional(StringEnum(["auto", "image", "video", "file"] as const)),
  caption: Type.Optional(Type.String({ description: "Optional text shown with the media." })),
  name: Type.Optional(Type.String({ description: "Display filename for kind=file." })),
});

pi.registerTool({
  name: "qq_send_media",
  label: "Send to QQ",
  description: "Send a local image, video, or file to the bound QQ private chat.",
  promptSnippet: "Send a local image, video, or file to the user's QQ chat",
  promptGuidelines: [
    "Use qq_send_media when the user wants to see a generated image, video, or file on QQ.",
    "Call qq_send_media once per artifact and pass its local path; do not paste local paths as markdown images.",
  ],
  parameters: mediaParams,
  executionMode: "sequential",
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // 见 §5.2
  },
});
```

`executionMode: "sequential"` 的依据见 `extensions.md:2305`：同一轮的工具默认并行，共享可变状态时应改串行。

注意：`onUpdate()` 的 partial result 和最终 result 的 `details` 类型必须一致（`extensions.md:2283`）。上面的草图为了简洁省略了统一的 `details` 类型；实现时应定义一个 `MediaToolDetails`。

### 2.3 工具气泡

pi-qq 会把每次工具调用和结果作为流式气泡回传 QQ（`src/relay/run-stream-relay.ts` 的 `onToolStart`/`onToolEnd`，`src/relay/stream-block-format.ts:105` 的 `formatToolLine`）。因此 `qq_send_media` 也会在 QQ 上产生一个工具气泡，默认图标是 `🔧`。建议：

- 在 `TOOL_ICONS` 中加 `qq_send_media: "📤"`，让气泡更直观。
- 工具结果保持一行，避免再刷屏。
- 如果不希望媒体旁边再出现一个工具气泡，可以在 `BubbleWriter`/`RunFeedback` 里对该工具做抑制；这是可选的体验优化，不影响功能。

---

## 3. QQ SDK 侧：媒体能力

### 3.1 API 一览

| API                                                                     | 行为                                         | 源码                            |
| ----------------------------------------------------------------------- | -------------------------------------------- | ------------------------------- |
| `bot.uploadMedia(opts)`                                                 | 只上传，返回 `{ file_uuid, file_info, ttl }` | `src/QQBot.ts:980`              |
| `bot.sendMedia(opts)`                                                   | 上传 + 立即发送                              | `src/QQBot.ts:1051`             |
| `bot.sendImage(target, source, opts)`                                   | `sendMedia` 的图片快捷方式                   | `src/QQBot.ts:1078`             |
| `bot.sendVideo(...)`                                                    | 视频快捷方式                                 | `src/QQBot.ts:1093`             |
| `bot.sendFile(...)`                                                     | 文件快捷方式，支持 `fileName`                | `src/QQBot.ts:1122`             |
| `bot.mediaApi.sendMediaMessage(scope, targetId, fileInfo, creds, opts)` | 用已有 `file_info` 发送媒体消息              | `src/protocol/api/media.ts:166` |

`sendMediaMessage` 的请求体是 `msg_type: 7`、`media: { file_info }`、`msg_seq`，可选 `content` 和 `msg_id`（`media.ts:180-185`）。

### 3.2 文件来源与分块

`uploadMedia` 支持四种互斥来源：`url`、`fileData`、`buffer`、`localPath`（`USAGE.md` §10.1）。pi-qq 应使用 `localPath`，让 SDK 自己读盘。

- 文件 ≥ `LARGE_FILE_THRESHOLD`（5 MB）时，SDK 自动走分块上传：`upload_prepare` → COS 预签名 PUT → `upload_part_finish` → `complete_upload`（`src/QQBot.ts:1004`，`src/protocol/api/media-chunked.ts`）。
- 小于 5 MB 走一次性 base64 上传。
- `onProgress` 只在分块路径触发；小文件上传没有进度回调。
- 分块上传适合大视频/大文件，调用方无感知；但 `localPath` 要求文件可读。

### 3.3 类型与大小上限

`src/protocol/utils/file-utils.ts:22`：

| 类型 | 枚举                      |   上限 |
| ---- | ------------------------- | -----: |
| 图片 | `MediaFileType.IMAGE` (1) |  30 MB |
| 视频 | `MediaFileType.VIDEO` (2) | 100 MB |
| 语音 | `MediaFileType.VOICE` (3) |  20 MB |
| 文件 | `MediaFileType.FILE` (4)  | 100 MB |

另外：

- 一次性上传的 base64 前置检查上限是 20 MB（`MAX_UPLOAD_SIZE`，`file-utils.ts:13`）。
- 分块上传的绝对上限是 100 MB（`CHUNKED_UPLOAD_MAX_SIZE`）。
- **高层 `QQBot.uploadMedia` 不按媒体类型校验大小**：源码里没有调用 `getMaxUploadSize`，超过平台限制时最终由 QQ API 报错。所以工具必须在调用前用 `stat` 校验。
- 可用 `getMaxUploadSize(fileType)` 查询上限（SDK 根导出）。

### 3.4 类型识别

SDK 的 `detectMediaKind` 按扩展名/MIME 分类（`src/protocol/utils/media-type.ts:66`）：

- 图片：`.jpg`、`.jpeg`、`.png`、`.gif`、`.webp`、`.bmp`
- 视频：`.mp4`、`.mov`、`.avi`、`.mkv`、`.webm`、`.flv`、`.wmv`
- 音频会被识别为 `voice`，其余为 `file`。

注意 `detectMediaKind` 从 `@tencent-connect/qqbot-nodejs/protocol` 导出，不在包根导出。若不想依赖子路径，也可以在 pi-qq 内维护一份相同的扩展名表。

需求只要求图片/视频/文件，建议：

- `image`/`video` 按扩展名白名单识别；
- 音频和其他类型一律按 `FILE` 发送，避免误走语音（QQ 语音对编码/容器有额外要求）；
- 允许 `kind` 参数强制指定，用于扩展名缺失或扩展名与实际内容不一致的情况。

### 3.5 被动回复与主动消息

`ReplyTarget` 的 `msgId` 决定发送方式（`USAGE.md` §5.2）：

- 有 `msgId`：被动回复，关联入站消息，受每条消息的回复次数和 TTL 限制。
- 无 `msgId`：主动消息，受 QQ 平台主动消息额度限制。

`sendMediaMessage` 在 `msgId` 存在时传 `msg_id` 并使用 `getNextMsgSeq(msgId)` 生成 `msg_seq`；否则 `msg_seq = 1`，且**仍然发送 `msg_seq`**（`src/protocol/api/media.ts:177-185`）。注意：主动文本消息的 `buildProactiveBody()` 不发送 `msg_seq`（`src/protocol/api/messages.ts`），所以主动媒体链路上 `msg_seq` 的语义需要在真实机器人上验证。

### 3.6 被动回复配额

SDK 的 `ReplyLimiter` 默认每条入站消息最多 4 次被动回复，TTL 1 小时（`src/protocol/utils/reply-limiter.ts:42-43`）。它只是工具类，不会自动记录；调用方必须：

1. 发送前 `checkLimit(msgId)`；
2. 发送成功后 `record(msgId)`。

pi-qq 已经封装为 `ReplyBudget`：

- 默认 `limit=4`，本地新鲜窗口 5 分钟（`src/quota/reply-quota.ts:32-34`）；
- `observeInbound()` 记录最近一条入站；
- `acquire()` 返回 `passive` 或 `proactive`；
- `commitPassive()` 记账；
- 流式气泡只通过 `noteStreamBubble()` 做诊断，不计入 4 次限制。

媒体消息按现有配额模型应当像文本一样计入被动回复：一次工具调用消耗一个被动回复名额；连续发 4 个媒体后，最终文本回复可能降级为主动消息。平台是否确实按这个口径计数，需要在真实机器人上验证（见 §7）。

### 3.7 错误类型

- `ApiError`：所有 HTTP 调用失败，带 `httpStatus`、`bizCode`、`bizMessage`、`path`（`src/protocol/types.ts:19`）。
- `UploadDailyLimitExceededError`：分块上传的 `upload_prepare` 命中日额度（业务码 `40093002`）时抛出（`src/protocol/api/media-chunked.ts:43`，`src/protocol/api/retry.ts:157`）。

工具应把这两类错误翻译成模型能理解、用户能行动的提示，例如“QQ 今日大文件上传额度已用完，请明天再试或发送更小的文件”。

### 3.8 上传缓存

`QQBot` 内置 LRU + TTL 上传缓存，按“文件内容 MD5 + scope + targetId + fileType”去重（`USAGE.md` §10.7）。同样的字节重复发送时，第二次可能直接复用 `file_info`，只付出发送消息的开销。分块路径也会复用缓存。

### 3.9 权限与格式

- `sendFile` 的文档注明“for users with file-message permission”（`src/QQBot.ts:1122` 附近注释，`USAGE.md` §10.5）。没有文件消息权限的机器人可能只能发图片/视频，或直接报权限错误。
- SDK 不做视频转码，也不校验编码；平台可能对容器/编码有额外要求。建议先用 `.mp4`（H.264/AAC）验证。
- 图片格式白名单是 SDK 侧的分类依据，不代表平台一定接受；仍以实际上传结果为准。

---

## 4. pi-qq 现有出站架构

### 4.1 文本回复

`src/qq/reply-sender.ts:111` 的 `sendReply()`：

- 按 4500 字符切块（`TEXT_CHUNK_LIMIT`）；
- 每块调用 `budget.acquire()` 选择被动/主动；
- 被动发送成功后 `commitPassive()`；
- 被动失败时自动重试主动消息，并 `onWarn()`。

### 4.2 目标与配额

- `ReplyBudget.observeInbound()` 在收到 QQ 消息时记录 `openid + msgId`（`src/qq/qq-message-handler.ts` 入口）。
- `acquire()` 在 5 分钟窗口内且未超过 4 次时返回被动目标；否则返回主动目标。
- 主动目标使用 `boundOpenid`（`getLoginState().allowedOpenid`），即 allowlist 里的唯一用户。

### 4.3 当前 run 的目标

`RunFeedback` 还维护了一份“本次 run 的来源目标”：

- `markQQTrigger(openid, msgId)` 在消息转给 pi 时调用（`src/relay/run-stream-relay.ts:58`，`src/qq/qq-message-handler.ts:153`）；
- `onAgentStart()` 在 15 秒内消费该 pending 目标；
- 断线恢复窗口 60 秒。

工具可以用 `ReplyBudget.lastTarget`/`acquire()`，也可以给 `RunFeedback` 加一个只读的 `getActiveTarget()` 来精确获取触发本次 run 的 `openid/msgId`。两者在单用户 C2C 场景下都可用；后者更适合未来多用户/群聊。

### 4.4 工具事件

`RunFeedback` 会把 `tool_execution_start` / `tool_execution_end` 转成流式气泡；这意味着 `qq_send_media` 的调用参数和结果会出现在 QQ 上。工具结果应保持简短。

### 4.5 最终文本

`index.ts` 的 `message_end` 处理器会在每条 assistant 消息结束时处理最终文本，并通过 `sendReply()` 发出。发送前会先经过 `markdownToPlain()`：Markdown 图片语法会被降级成替代文字，**不能靠 Markdown 图片回传效果图**，这也是需要媒体工具的直接原因。媒体工具通常在工具执行阶段发送，因此用户通常会先看到媒体，再看到最终文本；顺序符合“先看效果”的预期。

---

## 5. 推荐方案

### 5.1 工具形态

一个工具，单文件一次调用：

- 名称：`qq_send_media`
- 参数：
  - `path`：本地路径，支持绝对路径和相对 `ctx.cwd` 的路径；按 pi 文档建议去掉模型可能带上的前导 `@`。
  - `kind`：`auto | image | video | file`，默认 `auto`。
  - `caption`：可选说明文字，随媒体消息的 `content` 字段发送。
  - `name`：可选显示文件名，仅 `file` 类型生效。
- 不提供 `paths` 数组：一次调用发一个文件，多个文件让模型多次调用；工具设置串行，避免并发抢配额。
- 暂不提供 `url` 来源：本地路径更符合“生成结果回传”的场景，也避免 QQ 服务端拉取的域名白名单问题。后续可以加 `url` 作为可选来源。

### 5.2 执行流程

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const bot = running?.bot;
  const login = getLoginState();
  if (!bot || !login) throw new Error("QQ is not connected. Run /qq-login first.");

  const absPath = normalizePath(ctx.cwd, params.path); // 去掉 @，resolve
  const stat = await lstat(absPath);
  if (stat.isSymbolicLink()) throw new Error("Refusing to send a symlink.");
  if (!stat.isFile()) throw new Error("Not a regular file.");
  if (stat.size === 0) throw new Error("File is empty.");

  const fileType = resolveFileType(absPath, params.kind ?? "auto");
  const maxSize = getMaxUploadSize(fileType);
  if (stat.size > maxSize) {
    throw new Error(`File is ${formatBytes(stat.size)}; QQ limit for this type is ${formatBytes(maxSize)}.`);
  }

  const caption = params.caption?.slice(0, TEXT_CHUNK_LIMIT);
  const fileName = fileType === MediaFileType.FILE ? params.name : undefined;

  const upload = await bot.uploadMedia({
    target: { scope: "c2c", targetId: login.allowedOpenid },
    fileType,
    localPath: absPath,
    fileName,
    srvSendMsg: false,
    onProgress: (uploaded, total) => {
      onUpdate?.({
        content: [{ type: "text", text: `Uploading ${Math.round((uploaded / total) * 100)}%` }],
        details: { phase: "upload", uploaded, total },
      });
    },
  });

  // 上传可能耗时，发送前再取一次配额/窗口
  const reply = budget.acquire();
  const targetId = reply.openid ?? login.allowedOpenid;
  const msgId = reply.mode === "passive" ? reply.msgId : undefined;

  try {
    const message = await bot.mediaApi.sendMediaMessage(
      "c2c",
      targetId,
      upload.file_info,
      bot.getCredentials(),
      { msgId, content: caption },
    );
    if (msgId) budget.commitPassive(msgId);
    return {
      content: [{ type: "text", text: `Sent ${describeKind(fileType)} to QQ (${message.id}).` }],
      details: { fileType, path: absPath, size: stat.size, msgId, mode: reply.mode, messageId: message.id },
    };
  } catch (err) {
    if (!msgId) throw err;
    // 被动失败：用同一个 file_info 降级主动
    const message = await bot.mediaApi.sendMediaMessage(
      "c2c",
      login.allowedOpenid,
      upload.file_info,
      bot.getCredentials(),
      { content: caption },
    );
    onWarn?.(t("outbound.passiveFailed"));
    return {
      content: [{ type: "text", text: `Sent ${describeKind(fileType)} to QQ via proactive message (${message.id}).` }],
      details: { fileType, path: absPath, size: stat.size, mode: "proactive", messageId: message.id },
    };
  }
}
```

要点：

- 上传目标用 allowlist 的 `openid`，媒体上传接口只需要 `scope + targetId`。
- 发送前再 `acquire()`，避免上传耗时导致原来的 5 分钟窗口过期。
- 被动发送失败后复用 `upload.file_info` 做主动重试，不重新上传。
- 只有被动发送成功才 `commitPassive()`，与现有 `sendReply()` 的记账方式一致。

### 5.3 类型与大小

| `kind`              | 识别方式                              | 发送类型 |     上限 |
| ------------------- | ------------------------------------- | -------- | -------: |
| `auto` + 图片扩展名 | `.jpg/.jpeg/.png/.gif/.webp/.bmp`     | `IMAGE`  |    30 MB |
| `auto` + 视频扩展名 | `.mp4/.mov/.avi/.mkv/.webm/.flv/.wmv` | `VIDEO`  |   100 MB |
| `auto` + 其他       | 默认                                  | `FILE`   |   100 MB |
| `file`              | 强制                                  | `FILE`   |   100 MB |
| `image`/`video`     | 强制，但建议校验扩展名匹配            | 对应类型 | 对应上限 |

音频文件建议按 `FILE` 发送；如果以后要支持语音，再单独走 `VOICE`，并处理 silk/amr 等格式要求。

### 5.4 目标与配额

- 优先被动：`ReplyBudget.acquire()` 返回 `passive` 且 `msgId` 存在时，用该 `msgId` 发送。
- 降级主动：窗口过期或超过 4 次时，用 `{ scope: "c2c", targetId: boundOpenid }` 发送。
- 每次媒体成功发送都消耗一个被动名额；如果模型连续发多个媒体，最终文本回复可能变成主动消息。这是可接受的降级，但应在 README 中说明。
- 可选优化：给 `RunFeedback` 增加 `getActiveTarget()`，让工具优先使用触发本次 run 的 `msgId`，而不是最新入站消息。单用户场景差异不大。
- 可选优化：在工具层限制“每次 run 最多发 3 个媒体”，给最终文本留一个被动名额。不要把配额写死；先观察实际使用。

### 5.5 错误与降级

| 场景                              | 处理                                                      |
| --------------------------------- | --------------------------------------------------------- |
| 未登录/机器人未启动               | 抛错，提示 `/qq-login`                                    |
| 文件不存在                        | 抛错，返回绝对路径                                        |
| 目录/设备/符号链接                | 抛错，提示只支持普通文件                                  |
| 空文件                            | 抛错                                                      |
| 超过类型上限                      | 抛错，带上当前大小和上限                                  |
| 不支持的扩展名且 `kind=auto`      | 按 `FILE` 发送                                            |
| `kind=image/video` 但扩展名不匹配 | 建议抛错，避免平台端报错                                  |
| `UploadDailyLimitExceededError`   | 提示“今日大文件上传额度已用完，改发小文件或明天再试”      |
| `ApiError`                        | 带 `bizCode`/`bizMessage`，提示可能是权限、格式或频率问题 |
| 被动发送失败                      | 复用 `file_info` 主动重试一次；仍失败则抛错               |
| 主动消息失败                      | 抛错，提示主动消息额度可能已用完                          |

错误应通过 `throw` 或 `isError: true` 返回，不能只在 `content` 里描述失败，否则模型会当成成功。

### 5.6 并发与顺序

- `executionMode: "sequential"` 让多个 `qq_send_media` 调用串行，避免同时 `acquire()` 到同一个被动名额。
- `sendReply()` 和工具可能并发，但最终文本通常在工具结束后才发；实际冲突概率低。
- 如果要严格保证“媒体 → 文本”的顺序和配额准确，可以引入一个共享的 `OutboundQueue`，让 `sendReply()` 和媒体发送都经过同一个串行队列。这会增加改动面，建议先不做。
- 媒体上传没有 `AbortSignal` 支持；工具只能在开始前/上传后检查 `signal.aborted`，不能中途取消上传。大视频上传期间 agent 会保持忙碌，这是预期行为。

### 5.7 安全

- 模型本身已经能通过 `read`/`bash` 读取本机文件，所以“限制可发送路径”不是强安全边界；但建议至少：
  - 拒绝目录、设备、符号链接；
  - 用 `basename` 生成显示文件名；
  - 不把文件内容写进日志（SDK 已经对 `file_data` 做脱敏）。
- 如果希望更保守，可以加配置 `outboundMediaRoots`，默认只允许 `ctx.cwd` 和 `.pi/pi-qq/<sessionId>/uploads/`。但这会阻止发送 `~/Downloads` 等目录里的文件；是否值得由产品决定。
- 注意提示词注入：如果恶意内容诱导模型发送本机敏感文件，最终会发到同一个 allowlist 用户的 QQ。由于模型本来就能读取这些文件并以文本形式发出，风险没有本质增加；但可以在 README 中提醒“只让可信的 QQ 账号使用”。

### 5.8 建议改动点

| 文件                               | 改动                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `src/qq/outbound-media.ts`         | 新增：路径规范化、类型识别、大小校验、文件名处理                                   |
| `src/qq/media-tool.ts`             | 新增：构造 `qq_send_media` 工具定义，注入 bot/budget/login 依赖                    |
| `index.ts`                         | 启动时 `pi.registerTool(...)`，传入 `running`、`budget`、`getLoginState`、`onWarn` |
| `src/relay/stream-block-format.ts` | `TOOL_ICONS` 加 `qq_send_media: "📤"`                                              |
| `src/infra/i18n.ts`                | 新增发送成功/失败/降级提示的 key（如果工具结果要本地化）                           |
| `test/qq/outbound-media.test.ts`   | 纯函数测试                                                                         |
| `test/qq/media-tool.test.ts`       | 工具行为测试                                                                       |
| `README.md` / `README-zh.md`       | 说明工具用法、4 次被动回复限制、文件权限                                           |
| `CHANGELOG.md`                     | Unreleased 条目                                                                    |

### 5.9 可选优化

- 工具结果里附上 `file_uuid`、`ttl`，方便排查上传缓存问题。
- 对 `file` 类型显示文件大小和最终文件名。
- 上传进度通过 `onUpdate()` 更新本地 TUI；QQ 侧目前不会转发 `tool_execution_update`，所以手机上仍只会看到开始/结束。
- 如果希望媒体消息不产生工具气泡，可以在 `RunFeedback` 中对 `qq_send_media` 做特殊处理；但不建议一开始就做，先保留可观测性。

---

## 6. 测试计划

### 6.1 单元测试

纯函数：

- `resolveFileType`：jpg/png/gif/webp/bmp → image；mp4/mov/... → video；pdf/zip/mp3 → file；显式 `kind` 覆盖。
- 路径规范化：相对路径、绝对路径、前导 `@`、`..`、符号链接。
- 大小校验：空文件、刚好上限、超过上限。
- 文件名：basename、非法字符、空文件名回退。

工具行为（fake bot）：

- 被动成功：`uploadMedia` 用 allowlist openid、正确的 `fileType`/`localPath`；`sendMediaMessage` 带 `msgId`；`commitPassive` 被调用一次。
- 主动：`budget` 无目标或窗口过期时，`sendMediaMessage` 不带 `msgId`。
- 被动失败：第二次调用复用同一个 `file_info`，不带 `msgId`，不 `commitPassive`，触发 `onWarn`。
- 上传失败：不再调用 `sendMediaMessage`；`UploadDailyLimitExceededError` 被翻译。
- 超限/目录/空文件：在上传前失败，不产生网络调用。
- `caption` 截断到 4500 字符。
- 多个工具调用串行（`executionMode` 的行为由 pi 保证，但测试可以验证工具本身不共享可变状态）。

### 6.2 手工验证

- 从手机 QQ 发消息触发 run，让 pi 生成一张图片并调用工具；确认图片显示、caption 显示、最终文本顺序。
- 发送 6 MB 图片（走分块）、25 MB 图片（接近 30 MB 上限）、101 MB 文件（应被工具拒绝）。
- 发送 `.mp4` 视频，确认平台接受；再试 `.mov`/`.webm`，记录哪些格式可用。
- 连续发送 5 个媒体，确认第 5 个或最终文本降级为主动消息，并观察是否触发主动消息额度错误。
- 无文件消息权限的机器人：确认 `sendFile` 的错误提示是否可读。
- 断网/重启机器人后调用工具：确认“未连接”错误。
- 被动窗口过期（>5 分钟）后调用：确认走主动消息。

---

## 7. 风险与待验证

1. **媒体消息是否计入 4 次被动回复**：从协议上看应该计入；需要实测确认。如果不计入，配额逻辑可以简化，但不能假设。
2. **C2C 文件消息权限**：`sendFile` 可能需要额外权限；没有权限时的错误码和文案需要实测。
3. **视频编码/容器支持**：SDK 只按扩展名分类，平台可能要求特定编码；需要准备一个标准 mp4 测试。
4. **分块上传日额度**：`UploadDailyLimitExceededError` 的触发阈值和恢复时间由平台决定；工具只能提示用户。
5. **主动消息额度**：降级主动消息可能失败；需要观察实际额度。
6. **流式气泡与媒体消息的顺序**：工具开始时 `RunFeedback` 会先推送工具气泡头，媒体在工具执行中发送，工具结束后再推送结果；因此通常是“工具气泡头 → 媒体 → 工具结果 → 最终文本”。由于流式帧有节流，实际到达顺序需要实测确认是否符合预期。
7. **工具注册范围**：如果工具在扩展加载时注册，它也会出现在本地 TUI 会话中；执行时会检查登录状态。另一种做法是只在 `/qq-login` 成功后注册，但注销后无法方便地反注册。建议先采用“始终注册 + 执行时校验”。
8. **上传取消**：SDK 不支持上传中途取消；大文件上传会阻塞当前工具直到完成。如果体验不可接受，后续可以考虑把上传放到后台任务，但这会显著增加复杂度。
9. **重试重复发送**：被动发送失败但服务端实际已成功时，主动重试可能导致重复消息；现有 `sendReply()` 的文本降级也有同样风险。工具应记录日志，必要时在结果里说明已降级。
10. **主动媒体的 `msg_seq`**：主动模式下 SDK 固定发送 `msg_seq=1`（`media.ts:177`），而主动文本不发送 `msg_seq`。连续发多条主动媒体时是否会被平台去重或乱序，需要实测。

---

## 8. 参考

| 主题                  | 位置                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| pi 自定义工具文档     | `pi/packages/coding-agent/docs/extensions.md:2180`                              |
| pi 工具注册时机       | `pi/packages/coding-agent/docs/extensions.md:1586`                              |
| pi 工具定义类型       | `pi/packages/coding-agent/src/core/extensions/types.ts:599`                     |
| pi 工具结果类型       | `pi/packages/agent/src/types.ts:424`                                            |
| pi 扩展可用依赖       | `pi/packages/coding-agent/docs/extensions.md:155-170`                           |
| QQ SDK 上传/发送 API  | `qqbot-nodejs/src/QQBot.ts:980`、`:1051`、`:1078`、`:1093`、`:1122`             |
| QQ SDK 媒体消息请求体 | `qqbot-nodejs/src/protocol/api/media.ts:166`                                    |
| QQ SDK 媒体大小常量   | `qqbot-nodejs/src/protocol/utils/file-utils.ts:13-27`                           |
| QQ SDK 分块上传       | `qqbot-nodejs/src/protocol/api/media-chunked.ts`                                |
| QQ SDK 媒体类型识别   | `qqbot-nodejs/src/protocol/utils/media-type.ts:28-66`                           |
| QQ SDK 被动回复限制   | `qqbot-nodejs/src/protocol/utils/reply-limiter.ts:42-43`                        |
| QQ SDK 错误类型       | `qqbot-nodejs/src/protocol/types.ts:19`、`src/protocol/api/media-chunked.ts:43` |
| pi-qq 文本发送        | `pi-qq/src/qq/reply-sender.ts:111`                                              |
| pi-qq 回复预算        | `pi-qq/src/quota/reply-quota.ts:24-65`                                          |
| pi-qq run 目标        | `pi-qq/src/relay/run-stream-relay.ts:58-75`                                     |
| pi-qq 工具气泡格式    | `pi-qq/src/relay/stream-block-format.ts:10-110`                                 |
| pi-qq 入站处理        | `pi-qq/src/qq/qq-message-handler.ts:28-160`                                     |
