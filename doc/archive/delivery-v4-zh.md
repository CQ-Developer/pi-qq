# pi-qq delivery-v4

> **归档记录。** 内容反映 v4 交付时的状态，可能引用后续已变化的行为；现行说明见 [README-zh.md](../../README-zh.md)。
> 状态：v4 已交付；工具代码块已完成真实 QQ 验证；长耗时工具与离线投递仍是未决项。
> 版本：1.4.0
> 日期：2026-11-04
> 前序版本：[delivery-v1-zh.md](./delivery-v1-zh.md)、[delivery-v2-zh.md](./delivery-v2-zh.md)、[delivery-v3-zh.md](./delivery-v3-zh.md)。
> 未完成事项：[doc/todo.md](../todo.md)。

## 1. 交付范围

v4 是一次“输出质量 + 可观测性”交付，本记录合并了六份 v4 工作文档（名称为历史名称）：

- 工具启动可见性（`tool-return`）；
- Skill 执行展示（`send-skill`）；
- `/status`、中英文与电量（`enhance-status`）；
- QQ 手机后台收不到消息（`bugfix-v4`）；
- 长耗时工具导致无响应（`long-tool`）；
- 工具结果代码块类型（`block-type`）。

主要交付：

1. 新的工具气泡格式和代码块语言；
2. `SKILL.md` 读取使用独立 Skill 气泡；
3. QQ `/status` 与终端 `/qq-status` 统一展示执行状态、语言和电量；
4. QQ `/last` 作为手动恢复通道；
5. 长工具和流式失败的 debug 诊断日志。

本次不改变传输模型：仍然是 QQ C2C 私聊、被动回复和 `stream_messages` 流式输出。

## 2. 工具输出

### 2.1 气泡布局

每个内容块独立成泡。思考保持纯文本：

```text
**💭 思考**

推理内容...
```

工具调用使用二级标题：

````markdown
## 💻 bash

```bash
npm test
```

```text
12 passed
```
````

规则：

- 工具标题为 `## <图标> <工具名>`；
- `bash` 命令使用 `bash` 代码块，保留换行；
- bash 命令完整展示，不再套用旧的 200 字符参数上限；
- `read` / `write` / `edit` 的路径继续使用行内代码；
- 其他工具的主参数继续使用行内代码；
- 工具调用和结果始终在同一个气泡；
- 不在工具调用和结果之间切泡。

结果代码块语言按工具和文件类型选择：

| 来源            | 结果语言                            |
| --------------- | ----------------------------------- |
| `bash`          | `text`                              |
| `write`、`edit` | `text`                              |
| `read`          | 按扩展名选择；未知扩展名回退 `text` |
| 错误或空结果    | `text`                              |
| 其他工具        | `text`                              |

常用映射包括：`md` → `markdown`、`json` → `json`、`yaml` → `yaml`、`ts` → `typescript`、`tsx` → `tsx`、`js` → `javascript`、`py` → `python`、`sh`/`bash`/`zsh` → `bash`、`html` → `html`、`css` → `css`、`sql` → `sql`、`rs` → `rust`、`go` → `go`、`diff`/`patch` → `diff`。

特殊文件名：

- `Dockerfile` → `dockerfile`；
- `Makefile` → `makefile`；
- `CMakeLists.txt` → `cmake`；
- `README` → `markdown`。

空结果和失败结果始终使用 `text`。结果正文仍限制为 600 字符 / 8 行；bash 命令本身不截断。

固定图标：

| 工具     | 图标 | 工具     | 图标 |
| -------- | ---- | -------- | ---- |
| `bash`   | 💻   | `read`   | 📖   |
| `write`  | 📝   | `edit`   | ✏️   |
| `grep`   | 🔎   | `search` | 🔍   |
| `find`   | 🗂️   | `ls`     | 📁   |
| `list`   | 📋   | `web`    | 🌐   |
| `fetch`  | 📡   | `delete` | 🗑️   |
| `remove` | ❌   | `todo`   | ✅   |
| `test`   | 🧪   | 其他     | 🔧   |

### 2.2 Skill 气泡

读取 `SKILL.md` 时显示：

```markdown
## 🧩 Skill

`playwright-cli`
```

- skill 名称取父目录名；
- 支持 `path` 和 `file_path`；
- 支持 Unix 和 Windows 路径分隔符；
- 不转发 `SKILL.md` 内容；
- 不显示普通 `📖 read` 工具行和结果；
- 每次读取产生一个 Skill 气泡，不做去重；
- QQ 不支持 `/skill:`，只识别模型自动读取。

### 2.3 气泡边界

- 思考、工具、文本各自成块；
- 一次 run 可能产生多个气泡，但工具调用和结果始终同泡；
- `MAX_BUBBLE_CHARS = 12_000` 时在块边界或行首安全切泡；
- 不在未闭合代码围栏、待续写检查点或进行中的工具内切泡；
- 并行工具按开始顺序逐个展示，结果通过 `toolCallId` 归属；
- 工具未完成时，后续思考和文本暂存，避免插入工具调用和结果之间。

## 3. 状态、语言与电量

QQ `/status` 与终端 `/qq-status` 共用同一份格式化结果。

当前字段：

| 字段    | 内容                                             |
| ------- | ------------------------------------------------ |
| 标题    | `🖥️ pi-qq 状态`                                  |
| 登录    | 扫码登录与掩码 AppID，或“未登录”                 |
| 连接    | `已连接`、`重连中`、`已停止`、`启动中`、`已阻止` |
| 执行    | `执行中（QQ）`、`执行中（本地）`、`已完成`       |
| 模型    | 当前模型名                                       |
| 上下文  | tokens / window / percent                        |
| QQ 用户 | 掩码后的绑定 openid                              |
| 电量    | 百分比和充电/放电/AC；没有电池时隐藏             |
| 设置    | `~/.pi/agent/pi-qq.json`                         |

执行状态以 `ctx.isIdle()` 为全局信号，并用 `runFeedback.isQQRunActive()` 区分 QQ 任务和本地任务。

电量支持：

- Linux：`/sys/class/power_supply/BAT*`；
- macOS：`pmset -g batt`；
- Windows：PowerShell `Get-CimInstance Win32_Battery`；
- 结果缓存 30 秒；
- 读取失败静默隐藏 Battery 行；
- 不新增 npm 依赖。

中英文：

- 新增 `language` 配置，支持 `"zh-cn"` 和 `"en-us"`；
- 默认 `"zh-cn"`；
- 命令回复、状态、错误、流式占位符和 pi-qq 自有日志都走文案表；
- 日志保留稳定字段，并新增 `msgKey`，便于与语言无关地过滤；
- 第三方 SDK 的原始错误和日志保持原文；
- 非法配置回退默认值并给出警告。

`Bound user` 改名为 `QQ 用户`，并做 openid 掩码。

## 4. 工具启动可见性

调研结论：工具启动信息延迟主要来自流式合帧，不是工具执行本身。

- `AppendStream` 默认 500ms 节流，平台下限 300ms；
- 短工具的结果可能在 500ms 内进入同一个 buffer，导致工具名、参数和结果一起出现；
- 长工具通常会在约 500ms 后先发出启动帧；
- 并行工具受 `RunFeedback.activeTool` 串行输出限制，后启动的工具要等前一个工具结束。

v4 没有实现原计划中的工具启动 `flushAfter`。不过新的代码块格式把 bash 参数从行内代码改成 fenced block，避免了长行内代码被 QQ 折叠成一个点的问题。

1.3.6 增加了 debug 时序日志：

- 工具入队 / append start / append done；
- stream buffer、flush timer 和 flush 结果；
- 事件循环 `meanMs`、`maxMs`、`p99Ms`，后续又增加 `driftMs`。

## 5. 长耗时工具

### 5.1 失败链路

长工具可能导致 QQ 长时间无输出：

1. 工具运行期间没有新的 assistant 事件；
2. QQ 上只有工具启动气泡；
3. 长静默后，下一帧很容易触发 `msg_id` 过期或被动回复次数超限；
4. `BubbleWriter` 用同一个过期 `msg_id` / `stream_msg_id` 尝试 resume；
5. resume 次数耗尽后 `killStream()`，后续工具输出全部丢失；
6. writer 死亡时 `onToolEnd()` 直接返回，`activeTool` 和 deferred 文本卡住；
7. 最终 assistant 文本可能改走普通消息，超过 5 分钟后会降级为主动消息。

其他放大因素：

- 每个思考/工具气泡都会新建一条流式回复，但 `ReplyBudget` 没有把流式气泡计入 4 次被动回复上限；
- `/stop` 要等 `waitForEnd()` 才回复，可能占住 SDK 并发锁；
- 不转发 `tool_execution_update`，没有进度帧；
- 新 QQ 消息以 `steer` 排队，要等当前工具批次结束才处理。

### 5.2 已交付内容

- 只加 debug 诊断，不修改行为；
- QQ `/last` 作为手动恢复：
  - 运行中：`RunFeedback.repushCurrent()` 绑定到新的 `/last` 消息并重推当前文本；
  - 空闲时：`sendStreamReply()` 推送最近一次完成的 assistant 文本。
- 1.3.6 及后续补充的诊断：
  - 工具 `durationMs`、`updateCount`、`updateSpanMs`、首次部分输出；
  - run 目标选择、工具 queued/started/finished/ignored、assistant final 决策、run cleanup；
  - writer `dead`、`hasPendingResume`、`resumeAttempts`、`lastFrameAgeMs`；
  - 流式帧 `httpStatus`、`bizCode`、`path`、`msgSeq`、`streamMsgId`、`bufferLength`；
  - `/stop` 等待时长；
  - 事件循环 `driftMs`。

### 5.3 未修复的协议风险

v4 未修复：

- 流式气泡未计入被动回复额度；
- `DONE` 帧的 `content_raw` 为空；
- stream 请求同时发送 `event_id` 和 `msg_id`，而协议约定二选一；
- resume 复用已过期的标识；
- 没有过期被动窗口的待发送队列；
- 流式成功后没有普通文本终态兜底；
- SDK 没有心跳 ACK 超时检测；
- 没有启用 session persistence。

## 6. QQ 后台与离线投递

现象：iPhone QQ 长时间后台后重新打开，电脑上的 pi 仍在运行，但离线期间的机器人输出看不到；新入站消息仍能到达 pi，机器人也能回复新消息。

最可能的解释是手机端/平台离线投递问题：QQ 不会补发手机离线期间产生的流式机器人内容。由于没有事故日志，这一点尚未完全确认。

v4 已交付：

- `/last` 手动恢复；
- 登录、连接、执行、模型、上下文和额度的状态/诊断可见性。

v4 未交付：

- 60 分钟被动窗口修正（代码仍按 5 分钟）；
- 流式结束后的持久化最终文本；
- 下次入站时补发离线摘要；
- SDK 心跳 ACK 超时；
- session persistence；
- 运行中自动把 writer 重绑到新入站消息。

## 7. 诊断

终端命令：

- `/qq-test-budget`：被动预算和流式气泡计数；
- `/qq-test-md [text]`：Markdown 渲染测试；
- `/qq-test-stream`：流式时间线和 resume 测试。

日志：

- 在 `~/.pi/agent/pi-qq.json` 设置 `logLevel: "debug"`；
- 日志路径：`<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`；
- 可用 `PI_QQ_LOG_DIR` 覆盖目录；
- `info` 记录元数据；`debug` 记录完整事件、附件、提示词和工具参数/结果。

## 8. 模块与边界

<!-- prettier-ignore -->
| 模块 | 职责 |
| ---- | ---- |
| `index.ts` | 扩展装配、pi 事件、登录/会话命令、状态数据收集 |
| `src/qq/` | QQ 生命周期、扫码登录、入站路由、回复、诊断、状态格式化 |
| `src/relay/` | 思考/工具/文本回传、气泡布局、流式会话、工具结果格式化 |
| `src/quota/` | 被动回复预算与诊断 |
| `src/attachments/` | 文件下载、保存、pending、语音转写 |
| `src/infra/` | 配置、i18n、日志、电量、显示格式化 |

边界原则：

- 纯格式化放在 `stream-block-format.ts`；
- relay 编排放在 `run-stream-relay.ts` / `bubble-writer.ts`；
- 流式帧和重试放在 `stream-session.ts`；
- QQ 入站解析和命令路由放在 `src/qq/`；
- 所有配置通过 `settings.ts`；
- 模块由入口注入依赖，保持独立可测。

图片与文件共用保存/pending 流程；v4 之前的图片专用链路和 `imageMaxSize` 已移除。

## 9. 验证

- 单元测试：**172 passed**，18 个测试文件。
- TypeScript、ESLint、Prettier 检查通过。
- 2026-11-04 真实 QQ 工具代码块验证：
  - 测试目录：`/home/chen/project/pi-qq-test`；
  - 文件：`hello.py`、`Hello.java`、`hello.rs`、`hello.ts`；
  - 日志：`.pi/pi-qq/logs/pi-qq-2026-11-04.log`；
  - 观察到 `## 💻 bash` + bash 代码块、`## 📖 read` + rust/typescript 结果块、`## 📝 write` + 行内路径；
  - event-loop `driftMs` 为 0–1ms，`maxMs` 约 101ms。
- 本次验收未单独执行 `/qq-test-stream`。
- 仍建议在真实 QQ 上补一次 `/status` 和长任务/离线场景的手动验收。

## 10. 风险与限制

- 长任务可能耗尽 4 次被动回复，因为流式气泡没有计入额度。
- 超过 5 分钟会降级为主动消息；用户可能关闭主动消息。
- resume 无法恢复已过期的 `msg_id` / `stream_msg_id`。
- 长工具没有进度心跳，只有 `typing`。
- 工具启动可能受 500ms 节流影响。
- QQ 客户端对语言高亮的支持不一致。
- 12k 切泡依赖状态；极端单行或未闭合围栏仍可能触发平台行为。
- 仅支持 C2C 私聊；登录凭据只在进程内存。
- debug 日志可能包含提示词、工具参数和结果。

## 11. 未完成事项

- [doc/todo.md](../todo.md) 第 1 节：长运行 bash 参数/工具启动可见性。
- [doc/todo.md](../todo.md) 第 2 节：长耗时工具导致 QQ 侧无输出。
- 先修复流式气泡额度记账，再增加更多按块气泡。
- 设计过期被动窗口和 pending 输出的处理方式。
- 验证 `DONE` 内容以及 `event_id` / `msg_id` 用法。
- 增加进度心跳或转发 `tool_execution_update`。
- 增加 SDK 心跳 ACK 超时，评估 session persistence。
- 决定是否需要进一步验收 `/status` 和 `/last`。

在拿到真实现场日志前，本文和诊断日志是 v4 的判断依据；不把未经证实的 relay 重写纳入 v4。
