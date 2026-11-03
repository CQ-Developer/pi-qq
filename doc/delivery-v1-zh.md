# pi-qq delivery-v1

> 状态：v1 已交付，作为后续版本基线。
> 后续版本见 [delivery-v2-zh.md](./delivery-v2-zh.md)、[delivery-v3-zh.md](./delivery-v3-zh.md)。

## 1. 交付范围

v1 将 pi 接入 QQ 单人私聊（C2C）：

- 手机 QQ 发送文字、图片、文件；
- pi 在用户电脑上执行任务；
- assistant 文本回传到 QQ；
- 登录、命令、回复预算和连接生命周期可管理。

技术栈：

| 依赖                               | 用途                                             |
| ---------------------------------- | ------------------------------------------------ |
| `@tencent-connect/qqbot-nodejs`    | QQ 协议层：Gateway、C2C 消息、媒体上传、流式消息 |
| `@tencent-connect/qqbot-connector` | 扫码登录，凭据只保存在进程内存                   |
| `@earendil-works/pi-coding-agent`  | pi 扩展宿主、事件订阅、消息注入、上下文信息      |

## 2. 架构

扩展以目录形式加载，在 pi 进程内持有 QQBot：

```text
手机 QQ（C2C）
   │ WebSocket Gateway
   ▼
QQBot
   │ message
   ▼
pi-qq：白名单 → QQ 命令 → 文本/图片/文件
   │ pi.sendUserMessage()
   ▼
pi 会话
   │ message_update / message_end / agent_end
   ▼
pi-qq：格式化 → QQ 文本/流式消息
```

- QQ → pi：白名单校验后注入文本和图片；文件保存在工作区。
- pi → QQ：订阅 assistant 消息并回传；长任务使用独立的反馈时间线。
- 生命周期：`session_start` 启动 bot，`session_shutdown` 幂等停止。
- 断线重连由 SDK 负责；致命关闭码 4914/4915 给出明确错误。

## 3. 功能

### F1 扫码登录

- 只支持 `/qq-login` 扫码登录。
- 凭据只保存在进程内存，不写入配置文件；重启 pi 后重新扫码。
- 成功后绑定扫码用户 openid，其他 C2C 用户静默忽略。
- `/qq-logout` 清除凭据并断开连接。
- `/qq-status` 显示登录、连接、模型、上下文和绑定用户；AppID 脱敏。

### F2 单人聊天

- 只接受白名单用户的 C2C 消息。
- 文本通过 `pi.sendUserMessage()` 注入 pi。
- 忙碌时按 `deliverAs`（`steer` 或 `followUp`）排队。
- QQ 侧命令：`/new`、`/stop`、`/compact`、`/status`、`/help`。
- 运行期间发送 typing 指示。

### F3 图片和文件

图片：

- 下载后校验类型和大小，转换为 pi 的 `ImageContent`。
- 支持 jpg/jpeg/png/webp/gif；不支持的 `image/*` 明确拒绝。
- 单张超时 15 秒，默认上限 10MB。
- 部分图片失败时，成功图片仍注入，并回传失败清单。
- 当前模型不支持视觉输入时提示并跳过图片。

文件：

- 保存到 `.pi/pi-qq/YYYY-MM-DD/<msgId>/`，提示词附带绝对路径、大小和原始文件名。
- 单文件超时 60 秒，默认上限 50MB。
- 文件名安全化；同名文件自动追加 `-1`、`-2`。
- 文件内容不直接注入模型，由工具按需读取。

### F4 assistant 回传

- 数据源是 assistant 的 `message_end`。
- Markdown 转纯文本：去强调/标题/行内代码标记，列表转 `•`，链接转文字和 URL。
- 长文本按 `TEXT_CHUNK_LIMIT` 分块发送。
- 支持 C2C 流式追加；平台失败时降级为普通消息路径。
- `stopReason === "error"` 时回传错误摘要。

### F5/F6 用量摘要

已取消。不再发送 token、缓存、成本和上下文明细；上下文通过 `/status` / `/qq-status` 查看。

### F7 长任务反馈

v1 曾使用窗口汇总、工具计数和消息心跳维持长任务活性。该实现已在 v3 被 F12/F13 取代；v1 历史行为不代表当前版本。

## 4. 平台限制与预算

| 限制                            | 应对                                              |
| ------------------------------- | ------------------------------------------------- |
| 被动回复约 4 条 / 5 分钟窗口    | `ReplyBudget` 记录 `msgId` 配额，超限降级主动发送 |
| 流式消息仅 C2C，节流 ≥300ms     | `AppendStream` 负责合帧和退避                     |
| 单条文本约 5000 字符            | 自动分块                                          |
| 流式消息依赖 5 分钟内的 `msgId` | 过期后降级为普通消息                              |

## 5. 配置与命令

`~/.pi/agent/pi-qq.json` 只保存设置，不保存凭据。

| 配置            | 默认       | 说明                                     |
| --------------- | ---------- | ---------------------------------------- |
| `thinkingRelay` | `true`     | 回传思考正文                             |
| `deliverAs`     | `"steer"`  | 忙碌时新消息的排队方式                   |
| `imageMaxSize`  | 10MB       | 图片下载上限                             |
| `fileMaxSize`   | 50MB       | 文件下载上限                             |
| `logLevel`      | `"silent"` | 日志阈值                                 |
| `debug`         | 仅迁移读取 | `debug: true` 映射为 `logLevel: "debug"` |

pi 侧命令：`/qq-login`、`/qq-status`、`/qq-logout`、`/qq-test-budget`、`/qq-test-md`、`/qq-test-stream`、`/qq-new`。

QQ 侧命令：`/new`、`/stop`、`/compact`、`/status`、`/help`。

## 6. 模块与边界（v1 基线）

| 模块                         | 职责                                 |
| ---------------------------- | ------------------------------------ |
| `index.ts`                   | 扩展装配、事件订阅、命令注册         |
| `src/settings.ts`            | 只读配置与迁移                       |
| `src/qr-login.ts`            | 扫码登录                             |
| `src/qq-bot.ts`              | QQBot 生命周期、Gateway 状态、中间件 |
| `src/qq-message-handler.ts`  | 入站路由、命令、附件处理、注入 pi    |
| `src/image-attachments.ts`   | 图片校验与 `ImageContent`            |
| `src/file-attachments.ts`    | 文件保存、索引、提示词关联           |
| `src/attachment-download.ts` | 图片/文件通用限流下载                |
| `src/reply-sender.ts`        | Markdown 转换、分块、发送            |
| `src/reply-quota.ts`         | 被动回复预算                         |
| `src/reply-quota-report.ts`  | 预算诊断格式化                       |
| `src/display-format.ts`      | 字节与 token 格式化                  |
| `src/file-logger.ts`         | 文件日志                             |
| `src/run-stream-relay.ts`    | 长任务反馈状态机                     |
| `src/stream-session.ts`      | 流式追加、重试、续写检查点           |

边界原则：入口只做装配；协议、存储、格式化、预算分别放在独立模块；模块通过显式参数和 `RunFeedbackDeps` 之类的接口通信。

## 7. 验证

- 扫码登录、`/qq-status`、`/qq-logout` 实测通过。
- QQ 文本触发 pi，回复回传 QQ。
- 图片作为视觉输入、文件保存和提示词路径关联实测通过。
- 被动回复预算实测不超限；异常路径可降级主动发送。

## 8. 已知限制

- 仅支持 C2C 私聊。
- 登录凭据在进程内存，重启后必须重新扫码。
- 不提供开始确认和用量摘要，减少被动消息。
- 历史流式/心跳实现已由 v3 取代，不应作为当前行为参考。
