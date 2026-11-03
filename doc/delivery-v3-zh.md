# pi-qq delivery-v3

> 状态：v3 已实现并完成主链路真机验证；按块切泡、错误恢复、列表切分等最终细节仍需在目标 QQ 客户端做一次完整复验。
> 前序版本：[delivery-v1-zh.md](./delivery-v1-zh.md)、[delivery-v2-zh.md](./delivery-v2-zh.md)。

## 1. 交付范围

v3 收敛长任务回传与配置：

- F12：事件直推，思考、工具、文本按块回传；
- F13：移除消息心跳；
- F14：配置项收敛。

## 2. 输出模型

### 2.1 每个内容块一个气泡

按时间顺序：

1. 思考块；
2. 每个工具调用 + 结果；
3. 文本块；
4. 最终消息。

工具未完成时，后续思考/文本暂存，避免思考插入两个工具泡之间。并行工具按开始顺序逐个展示，结果通过 `toolCallId` 归属。

### 2.2 思考格式

每个思考泡首行：

```text
**💭 思考**
```

正文为纯文本，不加 `>` 引用前缀，空行和换行原样保留。达到 12k 安全边界时主动切泡，新泡重复标题。

不使用引用块的原因：QQ 会把单行/空行引用块渲染为不支持的消息；纯文本 + 标题可稳定显示。

### 2.3 工具格式

````text
**<图标> <工具名>**

`参数`

```text
输出
````

````

失败结果首行：

```text
❌ ...
````

每个工具调用独立气泡；工具名、参数和结果不拆开。

固定图标映射：

| 工具     | 图标 | 工具       | 图标 |
| -------- | ---- | ---------- | ---- |
| `bash`   | 💻   | `read`     | 📖   |
| `write`  | 📝   | `edit`     | ✏️   |
| `grep`   | 🔎   | `search`   | 🔍   |
| `find`   | 🗂️   | `ls`       | 📁   |
| `list`   | 📋   | `web`      | 🌐   |
| `fetch`  | 📡   | `delete`   | 🗑️   |
| `remove` | ❌   | `todo`     | ✅   |
| `test`   | 🧪   | 未配置工具 | 🔧   |

图标硬编码在 `src/relay/stream-block-format.ts`，不增加配置项。

### 2.4 文本与普通消息

assistant 文本按原文流式追加，不额外加标题。文本块和工具块之间通过气泡边界区分。

## 3. 切泡与流式传输

- 每个 run 默认多泡，但每个泡只承载一个内容块。
- 单块累计达到 `MAX_BUBBLE_CHARS = 12_000` 时，在安全边界切泡：
  - 块边界或行首；
  - 没有未闭合代码围栏；
  - 没有待续写检查点；
  - 没有进行中的工具。
- 思考切泡优先保证列表/行结构，不在行中间强制截断。
- 工具参数行与结果代码块始终在同一泡。
- `AppendStream` 负责 300ms 平台下限、500ms 默认合帧、429/50002 退避和同泡续写。
- `index` 每次发送尝试递增；失败帧的未确认缓冲用下一个 index 重发。
- 超过 5 分钟或平台拒绝时，最终文本通过普通消息路径补发。

## 4. 中断与错误恢复

### 4.1 `/stop`

`/stop` 的流程：

1. 取消错误恢复目标；
2. abort agent；
3. 等待 `agent_end` 完成当前流、工具结果和 DONE；
4. 回复 `Abort requested.`。

因此已启动的工具结果不会因为 `/stop` 丢失，也不会在 Abort requested 之后继续冒出排队工具泡。

### 4.2 模型错误恢复

- 模型错误结束时保留原 QQ 目标 60 秒。
- pi 自动恢复/重试产生的新 run 会沿用同一 `msgId` 继续推送。
- 没有输出的空重试不会消耗恢复目标；下一次重试仍可继续。
- 新 QQ 消息或 `/stop` 取消恢复。
- 恢复目标内的本地 run 也可能被回传，这是为了延续 pi 自动恢复行为的明确取舍。

## 5. 配置

`~/.pi/agent/pi-qq.json` 只保存设置，不保存凭据。

| 配置            | 默认       | 说明                                     |
| --------------- | ---------- | ---------------------------------------- |
| `thinkingRelay` | `true`     | 是否回传纯文本思考块                     |
| `deliverAs`     | `"steer"`  | 忙碌时新消息排队方式                     |
| `imageMaxSize`  | 10MB       | 图片下载上限                             |
| `fileMaxSize`   | 50MB       | 文件下载上限                             |
| `logLevel`      | `"silent"` | 日志阈值                                 |
| `debug`         | 仅迁移读取 | `debug: true` 映射为 `logLevel: "debug"` |

已删除配置：`streamRelay`、`streamFlushMs`、`streamAssistant`、`markdownSupport`、`heartbeatMinutes`、`heartbeatMaxMessages`。旧键静默忽略，不写回。

## 6. 模块分布与边界

当前代码按职责分层：

<!-- prettier-ignore -->
| 模块                         | 职责                                         |
| ---------------------------- | -------------------------------------------- |
| `index.ts`                   | 扩展装配、pi 事件订阅、命令和诊断接线        |
| `src/qq/qq-message-handler.ts`  | QQ 入站路由、命令、附件、注入 pi             |
| `src/qq/reply-sender.ts`        | Markdown 转纯文本、分块、消息发送            |
| `src/relay/run-stream-relay.ts`    | 内容块编排、气泡生命周期、工具队列、错误恢复 |
| `src/relay/stream-block-format.ts` | 思考标题、工具图标、参数/结果纯格式化 |
| `src/relay/stream-session.ts`      | 流式帧、节流、重试、续写检查点               |
| `src/quota/reply-quota.ts`         | 被动回复预算与 `msgId` 窗口                  |
| `src/quota/reply-quota-report.ts`  | 预算诊断文本                                 |
| `src/infra/settings.ts`            | 配置读取与旧键迁移                           |
| `src/qq/qq-bot.ts`              | QQBot/Gateway 生命周期和中间件               |
| `src/qq/qr-login.ts`            | 扫码登录                                     |
| `src/attachments/file-attachments.ts`    | 文件保存、索引、去重、pending                |
| `src/attachments/image-attachments.ts`   | 图片校验与视觉输入                           |
| `src/attachments/attachment-download.ts` | 图片/文件通用限流下载                        |
| `src/attachments/voice-transcript.ts`    | QQ ASR 文本提取                              |
| `src/infra/file-logger.ts`         | 结构化文件日志                               |
| `src/infra/display-format.ts`      | 字节/token 通用格式化                        |

边界原则：

- `index.ts` 不承载回传状态机；
- `stream-block-format.ts` 只做纯格式化，不依赖流对象；
- `run-stream-relay.ts` 只做编排，不直接拼 Markdown 细节；
- `stream-session.ts` 不感知内容块语义；
- `qq-message-handler.ts` 不实现下载、存储或预算；
- 所有配置通过 `settings.ts`，不散落在业务模块；
- 每个模块都有独立测试或可从入口注入依赖。

## 7. 验证

- 单元测试：**135 passed**（14 个测试文件）。
- TypeScript、ESLint 和 Prettier 检查通过。
- 真机已验证：
  - C2C 登录、文本、图片、文件；
  - 思考/工具/文本按块展示；
  - 工具行与结果同泡；
  - 12k 切泡与标题重复；
  - `/stop` 收尾、模型错误后的自动恢复。
- 仍需最终复验：
  - 目标客户端上的长列表切分；
  - 极端长代码围栏；
  - 错误恢复目标 TTL 接近边界的情况；
  - 并行工具较多时的消息额度。

## 8. 风险与限制

- 每个内容块一泡会增加消息数；长任务需关注被动额度。
- 12k 切泡依赖状态，极端单行/未闭合围栏仍可能落到平台自动切分。
- 工具图标是硬编码 Emoji，不同 QQ 客户端字体可能略有差异。
- 恢复目标是 60 秒 TTL；超过窗口后不再自动续传。
- 仅支持 C2C 私聊；登录凭据只在进程内存。
- 最终文本在流式失败时走普通消息路径，可能重复已显示的部分，优先保证完整。
