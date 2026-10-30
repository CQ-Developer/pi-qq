# pi-qq — features-v1.md

> pi 扩展：通过 QQ 机器人把 pi 接入 QQ 单人私聊（C2C）。
> 手机 QQ 上发消息（含图片/文件）→ pi 在机器上干活 → 完整回复（Markdown → 纯文本）回传到 QQ；上下文占比可通过 `/status` 查看。

技术栈：

| 依赖                                              | 用途                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `@tencent-connect/qqbot-nodejs`                   | QQ 开放平台协议层：WebSocket Gateway、C2C 消息收发、媒体上传、流式消息      |
| `@tencent-connect/qqbot-connector`                | 扫码登录：展示二维码，扫码后换取 `appId / appSecret / userOpenid`（仅内存） |
| `@earendil-works/pi-coding-agent`（ExtensionAPI） | pi 扩展宿主：事件订阅、命令注册、消息注入、上下文用量                       |

---

## 1. 总体架构

扩展以**目录形式**加载进 pi（`index.ts` + `package.json`），在 pi 进程内运行 QQBot 客户端：

```
手机 QQ（单人用户）
   │  C2C 私聊（WebSocket Gateway）
   ▼
QQBot（@tencent-connect/qqbot-nodejs，扩展内持有）
   │  bot.on("message")                      ▲ bot.sendText / openStream（纯文本）
   ▼                                          │
pi-qq 扩展 ── pi.sendUserMessage(text+images) ─┴─ pi 事件：
              （QQ → pi 注入）                  message_update / message_end /
                                                agent_end / ctx.getContextUsage()
```

- **QQ → pi**：入站 C2C 消息经白名单校验后，通过 `pi.sendUserMessage()` 注入 pi（文本 + 图片附件转 `ImageContent`）。
- **pi → QQ**：订阅 pi 生命周期事件，格式化后经 `bot.sendText / openStream` 回传（纯文本）。
- 生命周期：`session_start` 启动 bot、`session_shutdown` 幂等关闭；WebSocket 断线重连由 SDK 负责。

## 2. 核心功能

### F1 扫码登录（仅扫码）

**目标**：唯一登录方式是 `/qq-login` 扫码；凭据只保存在进程内存，绝不落盘。pi 进程退出后必须重新扫码。

**行为**

1. 用户在 pi 中执行 `/qq-login`。
2. 扩展停止现有连接，调用 `startQrConnect({ displayQrCodeToConsole: false, signal })`：
   - `onQrDisplayed(url)`：TUI 用 `qrcode-terminal` 把 URL 画成 ASCII 二维码；非 TUI 输出 URL。
   - `onQrExpired()`：提示二维码过期并自动刷新。
   - `onSuccess([{ appId, appSecret, userOpenid }])`：获取凭据与扫码人 openid。
3. 凭据写入进程内存（`globalThis` 登录状态），不写 `~/.pi/agent/pi-qq.json`。`userOpenid` 作为唯一绑定的 QQ 用户白名单。
4. 立即构造 `QQBot` 并启动；未完成扫码前可取消（Esc / AbortSignal）。
5. 同一 pi 进程内的 session reload / `/new` 会复用内存登录；pi 进程退出后内存清空，下次启动必须重新 `/qq-login`。
6. `/qq-logout` 立即清除内存凭据并断开连接；之后可重新扫码。

**通用**

- `/qq-status`、`/qq-login`、`/qq-logout`、`/qq-test-budget`、`/qq-test-md`、`/qq-test-stream`、`/qq-new` 的命令说明与 pi 终端输出均为英文。
- `/qq-status` 显示登录状态（in memory）、连接状态、模型、上下文与绑定用户；AppID 仅显示前 4 位 + `****`。
- 配置文件 `~/.pi/agent/pi-qq.json` 只保存非敏感设置；旧的 `AppID` / `AppSecret` / `allowedOpenid` 键会被忽略，不再用于登录。
- 白名单只接受扫码绑定的 openid；未登录时入站消息直接忽略。

### F2 单人聊天

**目标**：只有一个绑定的用户能与机器人对话，消息进入 pi 会话。

**行为**

- 仅接受 `kind === "c2c"` 的入站消息；发送者 openid 必须等于本次扫码绑定的内存白名单（复用 SDK `accessPolicy`，其他用户静默忽略）。入站消息的 `senderId` 即发送者的 openid。
- 普通文本 → `pi.sendUserMessage(text)`，触发正常 agent run。
- 图片消息的处理见 F3（QQ → pi）。
- agent 忙碌时收到新消息 → 按 `deliverAs`（默认 `steer`，可配置 `followUp`）排队。
- QQ 侧控制命令（在进入 pi 前拦截）：
  - `/new` 新会话、`/stop` 中止当前 run（`ctx.abort()`）、`/compact` 压缩上下文（`ctx.compact()`）、`/status` 会话与用量状态、`/help` 命令帮助。
- agent 工作期间向 QQ 发送 typing 提示（SDK `sendTyping`，C2C only）。

### F3 发送图片与文件（QQ → pi）

**目标**：用户在 QQ 上把图片或文件发给 pi；图片作为视觉输入，文件保存到本机并在提示词中给出路径。

**图片行为**

- 数据源：入站 C2C 消息的 `attachments`（`content_type` / `url` / `filename` / `size`）。
- 扩展下载图片 → 校验类型（jpg / jpeg / png / webp / gif）与大小 → 转 `ImageContent`（base64 + mimeType）→ 与消息文本一起 `pi.sendUserMessage()`。
- 类型判断：`content_type` 优先（兼容 `image/jpg`），非图片类型时按文件名扩展名兜底；明确声明为不支持的 `image/*`（如 svg）直接拒绝。
- 下载约束：单张超时 15s；`imageMaxSize` 默认 10MB；先看附件元数据，再在流式读取时二次限制实际字节数。
- 一条消息多张图片时按原顺序处理；部分失败时成功的图片仍注入，并回一条失败清单。
- 全部失败且没有文字/文件 → 不注入 pi，只回失败提示；有文字或文件 → 仍注入并提示图片失败。
- 当前模型无视觉能力（`ctx.model.input` 不含 `image`）时，QQ 提示并跳过图片；文字/文件仍处理。
- 已确认：pi 不向 QQ 发送图片——LLM 只能输出纯文本，无图片生成场景。

**文件行为**

- 非图片附件（如 zip/pdf/doc）下载后保存到当前工作空间的 `.pi/pi-qq/YYYY-MM-DD/<msgId>/<安全文件名>`。
- 文件名去掉路径与非法字符；同名文件自动加 `-1`、`-2` 后缀；不会写出保存目录。
- 单文件超时 60s；`fileMaxSize` 默认 50MB；同样先看元数据，再在流式读取时二次限流。
- 一条消息多个文件按原顺序保存；部分失败时成功的文件仍保留并给出失败清单。
- 提示词中追加文件块，例如：
  ```text
  User sent the following file(s) via QQ (saved locally; use read/bash or other tools to access):
  - /home/chen/project/myproj/.pi/pi-qq/2026-10-29/xxx/report.pdf (1.4MB, original name: report.pdf)

  User message:
  帮我总结这个文件
  ```
- 纯文件消息（无文字）也会触发 run，提示词只含文件块；文件内容不直接注入 LLM，由 pi 用工具按需读取。
- **实测**：2026-10-29 用户已验证 QQ 发送文件后保存到工作空间 `.pi/pi-qq/`，提示词中的路径可正常关联。

### F4 回传 assistant 消息

**目标**：pi 的回复实时出现在 QQ 聊天里。

**行为**

- 数据源：`message_end`（`message.role === "assistant"`）。回复通常为 **Markdown 格式**的总结/提问文本（已确认：LLM 编码完成后不在回复中写代码）。
- 内容处理：
  - 始终剔除 `thinking` 块（已确认：不回传思考内容）。
  - **Markdown 转换**：
    - 默认（无 markdown 权限，`markdownSupport: false`）：轻量转纯文本——去掉 `**` / `*` / `` ` `` 等强调与行内代码标记、标题转为文本行、列表项转 `•`、链接转 `文字(url)`、表格等复杂结构逐行退化；保持手机端可读性。
    - 机器人有 markdown 权限（`markdownSupport: true`）→ 透传原始 Markdown 由 QQ 客户端渲染。QQBot 构造时已传入 `markdownSupport`，SDK 的 `sendText` 会自动使用 msg_type=2，无需额外 `sendMarkdown`。
  - 超长文本按单条上限自动分块（SDK `TEXT_CHUNK_LIMIT = 5000`）。
- **流式模式**（默认开启，C2C 专属）：
  - `message_update` 期间用 `bot.openStream({ target })` 持续 `update(全文)`（对累积全文实时做同样的转换）；`message_end` 时 `complete()`。
  - 遵守 SDK 约束：节流 ≥300ms、必须基于 5 分钟内的入站消息（`msgId`）、传全文非增量。
- **非流式/降级**：`sendText` 一次性发送。
- `stopReason === "error"` 时回传错误摘要而非静默。

### F5/F6 用量摘要（已移除）

每轮 QQ 对话后的 token 用量摘要已取消：

- 不再在 `agent_end` 发送 `📊 用量摘要`。
- 上下文占比通过 QQ 侧 `/status` 或 pi 终端 `/qq-status` 查看。
- 不展示 token、缓存命中率、成本；减少一条被动回复消息。
- `usageRelay` 配置项已移除（旧配置键会被忽略）。

### F7 长任务反馈（10~60 分钟级任务）

**目标**：工具阶段长达数十分钟时保持"活着"的感知，且不烧穿消息额度。

**行为**：**assistant 文本消息与思考/工具汇总使用独立气泡**——每条文本消息独占一个纯文本气泡（同一消息的流式增量续写），思考/工具行组进入活动气泡；文本前后的工具执行均另起活动气泡；最终回复独立成文本气泡。`streamRelay` 默认开，实测可用；气泡内按 `streamFlushMs`（默认 10000ms，最小 300）固定频率发送窗口汇总帧（工具调用每 10s 汇总一次）：

```
[活动气泡] [💭] Thinking...
[活动气泡] [🔧] [3] bash
[活动气泡] [🔧] [2] read

[文本气泡] 中间消息原文

[活动气泡] [🔧] [1] edit

[文本气泡] 最终回复原文（流式增量）
```

- **汇总帧内容**（窗口增量，间隔 `streamFlushMs` 默认 10000ms；`agent_end` 补发剩余并收 DONE）。活动气泡帧：**debug 模式下行首带 `[HH:MM:SS]` 时间戳**，普通模式不带时间戳。行组**严格按事件实际发生顺序**输出：思考状态行 `[💭] Thinking...` 与工具计数行 `[🔧] [n] name` 按到达顺序交错；连续同名工具合并为一条计数，不改变相对顺序。文本气泡帧：原始 Markdown 增量（流式帧按 markdown 渲染），debug 模式才加时间戳以免插断回答。工具总在 message_end 后执行，故文本消息与其后工具天然分入不同气泡。
- **排版规则**：活动气泡内行与行相邻不空行；文本气泡内续写直接拼接；文本与工具不再混排。
- **气泡边界**：文本消息的**首个增量**到达 → 封口当前活动气泡，开文本气泡；思考/工具行组到达 → 封口当前文本气泡，开或续活动气泡；同一消息的后续流式增量不切泡；最终回复独立成文本气泡。
- **事件映射**：`tool_execution_start` → 窗口计数；`message_update`（thinking/text）→ 窗口状态/快照；`message_end` → 文本定稿；`agent_end` → 补帧 + DONE。AppendStream 内部仍有 500ms 节流与限流退避作安全网。
- **额度提示**：每条文本消息、每段活动各占一条 msg_seq 消息；长回合任务的气泡数多于单气泡模式，需关注被动额度；若平台拒绝（帧失败），该回合自动降级消息路径，文本仍完整送达。
- **降级**：任何一帧失败即标 dead，已追加部分作废，未发出的结果文本自动转消息路径补发；`streamRelay: false` 时整条时间线关闭，assistant 消息走普通消息路径（M2 行为）。
- **typing 保鲜**：run 开始立即发送"正在输入"，之后每 50s 续期（0 额度），`agent_end` 清理。
- **空窗口活性线**：窗口无增量且静默 ≥60s 时补一条 `⏱ Running for X minutes…`——长思考/单工具长执行期间每分钟一行，不再无推送（debug 模式带时间戳）。
- **心跳兜底**：流不可用时降级为普通消息心跳（每 run ≤3 条保险丝；debug 模式带时间戳）。
- 不发送"已收到"开始确认（节省被动额度）：QQ 触发的 run 在首个汇总帧前保持安静。
- 非 QQ 触发的 run（本地终端）不发心跳/时间线，但 assistant 消息仍照常回传（现状）。

## 3. 平台限制与回传预算（关键约束）

QQ 开放平台的发送限制直接决定回传策略，必须统一管理：

| 限制         | 数值                                       | 应对                                                                                |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| 被动回复额度 | 每条入站消息 5 分钟内有效，约 4 条/小时    | 扩展内维护回复预算（复用 SDK `ReplyLimiter` 思路）；assistant 时间线按文本/活动分泡 |
| 主动消息     | 无 `msgId` 发送受平台额度限制              | 被动额度耗尽时才降级为主动发送，且给出明确提示                                      |
| 流式消息     | 仅 C2C；节流 ≥300ms；基于 5 分钟内 `msgId` | 流式仅用于 assistant 文本；无关联 `msgId` 时自动降级 `sendText`                     |
| 文本长度     | 单条 ~5000 字符                            | SDK 分块；超出部分按序发送                                                          |
| markdown     | 默认无权限（`markdownSupport: false`）     | Markdown → 纯文本降级渲染                                                           |

**合并规则**（默认）：assistant 文本消息与活动时间线严格分泡（每条文本消息 1 条纯文本气泡，工具间隔另起活动气泡）；不再发送用量摘要，上下文占比通过 `/status` 查询。气泡数随回合内文本消息数增长，需关注 `msgId` 的被动额度；若平台拒绝（帧失败），自动降级消息路径。工具调用过程本身不逐条回传。

## 4. 配置

`~/.pi/agent/pi-qq.json`（只保存设置；不含凭据、不写入登录信息）：

| 字段                   | 默认                | 说明                                                                                 |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| `streamAssistant`      | `true`              | assistant 流式回传开关                                                               |
| `markdownSupport`      | `false`             | 机器人是否有 markdown 权限；`true` 时回传透传 Markdown                               |
| `deliverAs`            | `"steer"`           | 忙碌时新消息的处理方式                                                               |
| `imageMaxSize`         | `10MB`              | QQ 图片下载上限                                                                      |
| `fileMaxSize`          | `50MB`              | QQ 文件下载上限                                                                      |
| `heartbeatMinutes`     | `10`（0 关闭）      | F7 节流心跳间隔                                                                      |
| `heartbeatMaxMessages` | `3`                 | F7 每 run 消息心跳上限（流式心跳不受限）                                             |
| `streamRelay`          | `true`              | F7 流式载体开关（append 追加 + 节流合帧 + 限流退避，实测可用；失败自动降级消息路径） |
| `streamFlushMs`        | `10000`（最小 300） | F7 流式汇总帧间隔（毫秒，默认每 10s 汇总工具调用）                                   |
| `debug`                | `false`             | 诊断模式：SDK 日志转终端 + 流式重试/超时日志 + 行组/文本帧时间戳                     |

## 5. 命令总表

| 位置  | 命令                                        | 行为                                                 |
| ----- | ------------------------------------------- | ---------------------------------------------------- |
| pi 侧 | `/qq-login`                                 | 扫码登录并绑定（QR only）                            |
| pi 侧 | `/qq-status`                                | 登录态、连接状态、绑定用户                           |
| pi 侧 | `/qq-test-budget`                           | 诊断：被动额度、流式气泡数、最近 msgId 新鲜度        |
| pi 侧 | `/qq-logout`                                | 清除内存凭据并断开                                   |
| pi 侧 | `/qq-new`                                   | 重置当前会话（QQ `/new` 调用）                       |
| pi 侧 | `/qq-test-md [text]`                        | 诊断：发送 Markdown 消息，验证 C2C markdown 渲染能力 |
| pi 侧 | `/qq-test-stream`                           | 诊断：开流→三帧→complete，验证流式帧是否渲染         |
| QQ 侧 | `/new` `/stop` `/compact` `/status` `/help` | 会话控制（见 F2）                                    |

## 6. 可靠性与安全

- **生命周期**：`session_start` 仅在进程内存有登录态时启动；`session_shutdown` 幂等关闭。SDK 默认无限重连（退避 1s→60s），4914/4915 致命关闭码上报为不可恢复，提示重新 `/qq-login`。
- **回声与去重**：启用 SDK `messageFilter`（跳过 bot 回声）与 `concurrencyGuard`（同用户串行），避免流式与回复互相踩踏。
- **安全**：
  - 凭据仅保存在进程内存、不落盘；日志与 `/qq-status` 脱敏；扩展以 pi 同等权限运行，白名单外的消息不进入 pi（不产生任何工具执行）。
  - QQ 侧无 shell 类命令；一切工具执行都经由 pi 自身权限体系。

## 7. 决策记录

| #   | 问题                   | 决策                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TUI 二维码渲染         | 登录协议用 connector；展示用 `qrcode-terminal`（零依赖）在 `ctx.ui` 弹窗画码                                                                                                                                                                                                                                     |
| 2   | thinking 内容          | 不回传具体内容（始终剔除，无配置开关）；F7 时间线中仅以 `[💭] Thinking...` 标记体现                                                                                                                                                                                                                              |
| 3   | tool 消息              | **完全不回传**；只回传 assistant 消息，上下文占比通过 `/status` 查询                                                                                                                                                                                                                                             |
| 4   | 图片方向               | F3 为 QQ → pi（用户发图给 pi）；pi 不向 QQ 发图片（LLM 仅输出纯文本）                                                                                                                                                                                                                                            |
| 5   | 成本/用量摘要          | 已移除每轮用量摘要；不展示 token、缓存命中率、成本                                                                                                                                                                                                                                                               |
| 6   | 回复格式               | 回复通常为 Markdown 格式的总结/提问文本（不在回复中写代码）；默认轻量转纯文本，有 markdown 权限可透传                                                                                                                                                                                                            |
| 7   | 登录方式               | 仅 `/qq-login` 扫码；凭据只存进程内存、不落盘；pi 进程退出后必须重新扫码                                                                                                                                                                                                                                         |
| 8   | 长任务反馈             | typing 保鲜 + 每 10s 汇总工具调用 + 节流心跳（默认 10 分钟/条，流式载体优先，每 run ≤3 条消息心跳保险丝）+ 机会性流式（平台拒绝即降级）；不发送开始确认                                                                                                                                                          |
| 9   | 流式可用性（实测三轮） | ① C2C markdown（msg_type=2，`sendMarkdown`）渲染正常；② SDK 内置流式 `input_mode="replace"` 被平台拒绝（"已经提交的消息内容不可修改"），首帧可渲染、后续帧报错；③ 自实现 `AppendStream`（input_mode="append"，增量追加 + DONE）实测通过；补齐节流合帧（500ms）与限流退避重试后**默认开启**，失败自动降级消息路径 |

## 8. 里程碑

| 阶段 | 内容                                         | 验收                                         |
| ---- | -------------------------------------------- | -------------------------------------------- |
| M1   | F1 扫码登录 + 内存凭据 + 连接启动            | 扫码后 `/qq-status` 在线；重启 pi 需重新扫码 |
| M2   | F2 单人聊天 + F4 assistant 回传（先非流式）  | QQ 发消息得到 pi 回复                        |
| M4   | F3 QQ 图片/文件消息 + markdownSupport + 打磨 | 图片可进入 pi 会话；文件保存并关联到提示词   |

> 原 M3 用量摘要已取消（2026-10-29）。
