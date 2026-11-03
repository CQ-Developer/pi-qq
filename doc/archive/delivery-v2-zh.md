# pi-qq delivery-v2

> 状态：v2 已交付，本文为历史记录。
> 当前行为以 [README-zh.md](../README-zh.md) 为准；前序版本：[delivery-v1-zh.md](./delivery-v1-zh.md)；后续版本：[delivery-v3-zh.md](./delivery-v3-zh.md)。

## 1. 交付范围

v2 在 v1 的 QQ 私聊、图片和文件能力上增加：

- F8 语音消息自动转写；
- F9 结构化日志基础设施；
- F10 文件消息等待下一条指令；
- F11 文件保存路径、索引和去重。

## 2. 功能

### F8 语音消息

- 使用 QQ 内置 ASR（`asr_refer_text`），不下载音频。
- 转写文本作为普通用户文本交给 pi。
- ASR 无结果时回复 `Could not transcribe this voice message; please resend or type it.`，不启动 run。
- 不依赖本地或外部语音识别服务。
- 原始 ASR 结果和附件元数据只在 `debug` 日志中记录。

### F9 日志

- 按天写入 `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`。
- `PI_QQ_LOG_DIR` 可覆盖目录。
- 阈值：`silent`、`error`、`warn`、`info`、`debug`。
- `info` 只记录元数据；`debug` 记录完整事件、附件、提示词和工具参数/结果。
- 日志 JSONL 化，错误对象带名称、消息和堆栈。
- 旧配置 `debug: true` 映射为 `logLevel: "debug"`。

### F10 文件等待指令

- 只发送文件不会启动 pi；文件先保存并进入 pending。
- 下一条文字或语音指令会消费 pending 文件，并在提示词中附带路径、大小和原始文件名。
- 指令前上传多个文件会合并到同一个提示词。
- `/new` 清空 pending。
- 文件按当前 pi 会话隔离。

### F11 文件存储与去重

- 保存在当前工作区 `.pi/pi-qq/<sessionId>/uploads/`。
- 同名同内容复用已有文件。
- 同名不同内容保存为 `name-1.ext`。
- 不同名同内容分别保存。
- 索引只记录文件名到哈希的映射；路径和大小来自文件系统。启动时清理失效索引。
- pending 文件与索引解耦，`/new` 不影响已保存的索引文件。

## 3. 配置

v2 继续使用：

| 配置            | 默认       | 说明                 |
| --------------- | ---------- | -------------------- |
| `thinkingRelay` | `true`     | 思考正文回传开关     |
| `deliverAs`     | `"steer"`  | 忙碌时的消息排队方式 |
| `imageMaxSize`  | 10MB       | 图片下载上限         |
| `fileMaxSize`   | 50MB       | 文件下载上限         |
| `logLevel`      | `"silent"` | 日志阈值             |
| `debug`         | 仅迁移读取 | 旧日志开关迁移       |

## 4. 模块与边界

<!-- prettier-ignore -->
| 模块                         | 职责                                 |
| ---------------------------- | ------------------------------------ |
| `src/qq/qq-message-handler.ts`  | 语音/文件/文本统一入站路由；命令拦截 |
| `src/attachments/voice-transcript.ts`    | ASR 文本提取与可用性判断             |
| `src/attachments/file-attachments.ts`    | 文件保存、哈希、索引、pending 提示词 |
| `src/attachments/attachment-download.ts` | 图片和文件共用下载约束               |
| `src/attachments/image-attachments.ts`   | 图片校验与视觉输入组装               |
| `src/infra/file-logger.ts`         | 日志级别、格式化、按天写入           |
| `src/qq/reply-sender.ts`        | Markdown 转换、分块、发送            |
| `src/quota/reply-quota.ts`         | 被动回复预算                         |

边界原则：

- `qq-message-handler` 只负责路由，不自行实现下载或存储细节；
- `voice-transcript` 不接触文件系统；
- `file-attachments` 负责保存和索引，不负责 pi 事件；
- `file-logger` 不依赖业务模块；
- 所有附件下载都经过 `attachment-download.ts`，避免超时和大小限制分叉。

## 5. 验证

- 语音 ASR 文本注入、无文本提示、音频不落盘；
- 纯文件消息不启动 run，下一条指令消费文件；
- 多文件合并、`/new` 清空 pending；
- 同名同内容复用、同名不同内容加后缀、不同名同内容独立保存；
- 日志目录、级别、JSONL 字段和旧 `debug` 迁移；
- 自动化和实机测试通过。

## 6. 已知限制

- 仅使用 QQ ASR，不提供本地识别兜底。
- ASR 不返回文本时只能重发或改文字。
- 文件等待指令按当前 pi 会话隔离。
- 日志的 `debug` 级别会包含敏感工具参数和文件内容，只在排查问题时开启。
