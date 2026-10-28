# pi-qq — features.md

> pi 扩展：通过 QQ 机器人把 pi 接入 QQ 单人私聊（C2C）。
> 手机 QQ 上发消息（含图片）→ pi 在机器上干活 → 完整回复（Markdown → 纯文本）+ token 用量与上下文占比回传到 QQ。

技术栈：

| 依赖 | 用途 |
| --- | --- |
| `@tencent-connect/qqbot-nodejs` | QQ 开放平台协议层：WebSocket Gateway、C2C 消息收发、媒体上传、流式消息 |
| `@tencent-connect/qqbot-connector` | 扫码登录（方式 B）：展示二维码，扫码后换取 `appId / appSecret / userOpenid` |
| `@earendil-works/pi-coding-agent`（ExtensionAPI） | pi 扩展宿主：事件订阅、命令注册、消息注入、上下文用量 |

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

### F1 登录接入（配置直连 / 扫码）

**目标**：两种方式接入机器人，凭据统一存放在 `~/.pi/agent/pi-qq.json`（权限 `0600`）。

**方式 A：配置文件直连（免扫码）**

用户预先在 `~/.pi/agent/pi-qq.json` 写入：

```json
{
    "AppID": "...",
    "AppSecret": "..."
}
```

- 规则（已确认）：配置文件中存在有效凭据 → 启动时直接构造 `QQBot` 接入，**无需扫码**；否则进入扫码流程。
- 读取时兼容小写 `appId` / `appSecret`；文件中其余配置项（§4）可共存。
- 手动配置时若未填 `allowedOpenid`：第一个发来 C2C 私聊的用户自动绑定为单人用户（写入配置并在 pi 侧提示），也可手动预先填写。

**方式 B：扫码登录**

1. 用户在 pi 中执行 `/qq-login`。
2. 扩展调用 `startQrConnect({ displayQrCodeToConsole: false, signal })`：
   - `onQrDisplayed(url)`：TUI 模式下用 `qrcode-terminal`（零依赖）把 `url` 画成 ASCII 二维码嵌入 `ctx.ui` 弹窗；非 TUI 模式直接打印 URL。
   - `onQrExpired()`：提示"二维码已过期，已自动刷新"。
   - `onSuccess([{ appId, appSecret, userOpenid }])`：进入下一步。
3. 凭据按方式 A 的 schema 写回 `~/.pi/agent/pi-qq.json`，`userOpenid` 写入默认单人绑定。`userOpenid` 即**扫码人的 openid**：QQ 开放平台用户的机器人内唯一标识（非 QQ 号，平台不向机器人暴露真实 QQ 号）；谁扫码绑定，谁就是允许对话的"单人"，写入 `allowedOpenid` 作为白名单。
4. 立即构造 `QQBot` 并启动；未扫码完成前可随时取消（`stop()` / AbortSignal）。

**通用**

- `/qq-status` 显示登录方式、凭据来源、绑定用户、连接状态；`/qq-logout` 清除凭据并断开。
- `/qq-login` 始终可用：已直连时重新扫码换绑。
- 职责划分：connector 负责**登录协议**（生成绑定任务、轮询、解密凭据），二维码绘制只是展示层；M1 允许先用 connector 自带控制台打印（`displayQrCodeToConsole: true`）跑通，再优化 TUI 弹窗（直接 console 打印会破坏 pi TUI 渲染）。
- 凭据脱敏：日志与 `/qq-status` 中只显示 `AppID` 前几位。

### F2 单人聊天

**目标**：只有一个绑定的用户能与机器人对话，消息进入 pi 会话。

**行为**

- 仅接受 `kind === "c2c"` 的入站消息；发送者 openid 必须等于配置的 `allowedOpenid`（复用 SDK `accessPolicy` 白名单中间件，其他用户静默忽略）。入站消息的 `senderId` 即发送者的 openid。
- 普通文本 → `pi.sendUserMessage(text)`，触发正常 agent run。
- 图片消息的处理见 F3（QQ → pi）。
- agent 忙碌时收到新消息 → 按 `deliverAs`（默认 `steer`，可配置 `followUp`）排队。
- QQ 侧控制命令（在进入 pi 前拦截）：
  - `/new` 新会话、`/stop` 中止当前 run（`ctx.abort()`）、`/compact` 压缩上下文（`ctx.compact()`）、`/status` 会话与用量状态、`/help` 命令帮助。
- agent 工作期间向 QQ 发送 typing 提示（SDK `sendTyping`，C2C only）。

### F3 发送图片（QQ → pi）

**目标**：用户在 QQ 上把图片发给 pi，作为视觉输入参与对话。

**行为**

- 数据源：入站 C2C 消息的 `attachments`（`content_type` / `url` / `filename`）。
- 扩展下载图片 → 校验类型（jpg / png / webp / gif）与大小 → 转 `ImageContent`（base64 + mimeType）→ 与消息文本一起 `pi.sendUserMessage()`（接口原生支持 `TextContent | ImageContent[]` 混合）。
- 一条消息多张图片时按顺序全部注入。
- 约束与降级：
  - 下载超时 / 超限（默认上限 10MB，可配置）/ 类型不支持 → QQ 回一条失败提示，不注入 pi。
  - 当前模型无视觉能力时，QQ 提示"当前模型不支持图片输入"。
- 已确认：pi 不向 QQ 发送图片——LLM 只能输出纯文本，无图片生成场景（原 pi → QQ 的 `qq_send_image` 方案移除）。

### F4 回传 assistant 消息

**目标**：pi 的回复实时出现在 QQ 聊天里。

**行为**

- 数据源：`message_end`（`message.role === "assistant"`）。回复通常为 **Markdown 格式**的总结/提问文本（已确认：LLM 编码完成后不在回复中写代码）。
- 内容处理：
  - 始终剔除 `thinking` 块（已确认：不回传思考内容）。
  - **Markdown 转换**：
    - 默认（无 markdown 权限，`markdownSupport: false`）：轻量转纯文本——去掉 `**` / `*` / `` ` `` 等强调与行内代码标记、标题转为文本行、列表项转 `•`、链接转 `文字(url)`、表格等复杂结构逐行退化；保持手机端可读性。
    - 机器人有 markdown 权限（`markdownSupport: true`）→ 透传原始 Markdown 由 QQ 客户端渲染。
  - 超长文本按单条上限自动分块（SDK `TEXT_CHUNK_LIMIT = 5000`）。
- **流式模式**（默认开启，C2C 专属）：
  - `message_update` 期间用 `bot.openStream({ target })` 持续 `update(全文)`（对累积全文实时做同样的转换）；`message_end` 时 `complete()`。
  - 遵守 SDK 约束：节流 ≥300ms、必须基于 5 分钟内的入站消息（`msgId`）、传全文非增量。
- **非流式/降级**：`sendText` 一次性发送。
- `stopReason === "error"` 时回传错误摘要而非静默。

### F5 回传 token 详情（输入 / 缓存命中 / 输出）

**数据源**：assistant 消息的 `usage`：`input`、`cacheRead`、`output`（及可选 `cacheWrite`、`cost`）。

**行为**

- 每次 agent run 结束（`agent_end`）发送一条用量摘要：
  `📊 tokens — 输入 12.3k（缓存命中 11.8k）· 输出 1.2k · 成本 $0.04 · 本轮 2.1k`
- 成本（`usage.cost.total`）随摘要一并回传（已确认）；模型无定价数据时省略成本字段。
- 三层数字：
  - **本轮**：`turn_end` 中最后一条 assistant 消息的 `usage`（该次模型请求的增量）。
  - **会话累计**：扩展内累计（`session_start` 时从 `sessionManager.getBranch()` 的 assistant 条目重建，`/new` 后清零）。
- 与 F6 合并为一条消息发送，避免刷屏。

### F6 回传上下文窗口占比

**数据源**：`ctx.getContextUsage()` → `{ tokens, contextWindow, percent }`。

**行为**

- 与 F5 同条消息附带：`| 上下文 46.5k/200k（23%）`。
- `tokens === null`（压缩后尚未产生新响应）时显示"重建中"，不发数字。
- 达到阈值（默认 80%）时在摘要中追加提示"建议 /compact"。

### F7 长任务反馈（10~60 分钟级任务）

**目标**：工具阶段长达数十分钟时保持"活着"的感知，且不烧穿消息额度。

**行为**：**每回合一个独立流式气泡**（回合 = 一条 assistant 消息及其后续工具执行；`streamRelay` 默认开，实测可用），气泡内按 `streamFlushMs`（默认 3000ms，最小 300）固定频率发送窗口汇总帧：

```
💭 思考中...
🔧 bash * 3
🔧 read * 2

中间消息原文
🔧 edit * 1

最终回复原文（流式增量）
```

- **汇总帧内容**（窗口增量，间隔 `streamFlushMs` 默认 3000ms；`agent_end` 补发剩余并收 DONE）。**行组帧首行带时间戳 `[HH:MM:SS]`**（纯文本增量帧不加，避免插断流式回答）。**帧内顺序（用户确认）：任何消息原文先推送、发完之后才推工具汇总**：思考状态行（惰性）→ 消息文本增量（原始 Markdown，流式帧按 markdown 渲染）→ 工具计数行 `name * n`（本窗口调用数，无参数，决策 #3）。时序保证：工具总在 message_end 后执行，故文本必然先于其工具汇总完整发出。
- **排版规则**：文本块前空一行（紧随行组时）；文本续写直接拼接；工具计数行紧随文本（仅换行不空行）；行组相邻不空行。
- **事件映射**：`message_start`（assistant）→ 封口上一气泡（补帧 + DONE）并开新气泡；`tool_execution_start` → 窗口计数 + 🔧 行；`message_update`（thinking/text）→ 窗口状态/快照；`message_end` → 文本定稿；`agent_end` → 补帧 + DONE。AppendStream 内部仍有 500ms 节流与限流退避作安全网。
- **额度提示**：每回合一个气泡 = 每回合一条新 msg_seq 消息，长回合任务的消息数多于单气泡模式；若平台拒绝（帧失败），该回合自动降级消息路径，文本仍完整送达。
- **降级**：任何一帧失败即标 dead，已追加部分作废，未发出的结果文本自动转消息路径补发；`streamRelay: false` 时整条时间线关闭，assistant 消息走普通消息路径（M2 行为）。
- **开始确认**（QQ 触发的 run，t=0）：立即回一条"✅ 已收到，开始处理…"（1 条被动额度，窗口内必达）。
- **typing 保鲜**：run 期间每 50s 续期一次"正在输入"（0 额度），`agent_end` 清理。
- **空窗口活性线**：窗口无增量且静默 ≥60s 时补一条 `[HH:MM:SS] ⏱ 已运行 X 分钟…`——长思考/单工具长执行期间每分钟一行，不再无推送（时间戳可用于核对节奏）。
- **心跳兜底**：流不可用时降级为普通消息心跳（每 run ≤3 条保险丝，带时间戳）。
- 非 QQ 触发的 run（本地终端）不发确认/心跳/时间线，但 assistant 消息仍照常回传（现状）。

## 3. 平台限制与回传预算（关键约束）

QQ 开放平台的发送限制直接决定回传策略，必须统一管理：

| 限制 | 数值 | 应对 |
| --- | --- | --- |
| 被动回复额度 | 每条入站消息 5 分钟内有效，约 4 条/小时 | 扩展内维护回复预算（复用 SDK `ReplyLimiter` 思路）；assistant 流式算 1 条，用量摘要合并为 1 条 |
| 主动消息 | 无 `msgId` 发送受平台额度限制 | 被动额度耗尽时才降级为主动发送，且给出明确提示 |
| 流式消息 | 仅 C2C；节流 ≥300ms；基于 5 分钟内 `msgId` | 流式仅用于 assistant 文本；无关联 `msgId` 时自动降级 `sendText` |
| 文本长度 | 单条 ~5000 字符 | SDK 分块；超出部分按序发送 |
| markdown | 默认无权限（`markdownSupport: false`） | Markdown → 纯文本降级渲染 |

**合并规则**（默认）：assistant 文本走流式；token 详情 + 上下文占比在 `agent_end` 合并为一条"用量摘要"发送。即**一个回合 ≈ 1 条流式消息 + 1 条用量摘要**，稳定处于被动额度之内。工具调用过程不回传。

## 4. 配置

`~/.pi/agent/pi-qq.json`（手动配置或扫码登录写入，同一文件、同一 schema）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `AppID` / `AppSecret` | 手动填写或扫码写入 | 机器人凭据（`0600` 保护）；存在即免扫码直连（兼容小写 `appId` / `appSecret`） |
| `allowedOpenid` | 扫码自动写入；手动配置时可选（缺省首个私聊用户绑定） | 单人绑定的 openid |
| `streamAssistant` | `true` | assistant 流式回传开关 |
| `markdownSupport` | `false` | 机器人是否有 markdown 权限；`true` 时回传透传 Markdown |
| `usageRelay` | `true` | token 详情 + 成本 + 上下文占比开关 |
| `deliverAs` | `"steer"` | 忙碌时新消息的处理方式 |
| `contextWarnPercent` | `80` | 上下文占比告警阈值 |
| `imageMaxSize` | `10MB` | QQ 图片下载上限 |
| `heartbeatMinutes` | `10`（0 关闭） | F7 节流心跳间隔 |
| `heartbeatMaxMessages` | `3` | F7 每 run 消息心跳上限（流式心跳不受限） |
| `streamRelay` | `true` | F7 流式载体开关（append 追加 + 节流合帧 + 限流退避，实测可用；失败自动降级消息路径） |
| `streamFlushMs` | `3000`（最小 300） | F7 流式汇总帧间隔（毫秒） |
| `debug` | `false` | 诊断模式：SDK 内部日志（超时/限流/重连）转终端 + 文本增量帧也带时间戳 |

## 5. 命令总表

| 位置 | 命令 | 行为 |
| --- | --- | --- |
| pi 侧 | `/qq-login` | 扫码登录并绑定 |
| pi 侧 | `/qq-status` | 登录态、连接状态、绑定用户 |
| pi 侧 | `/qq-logout` | 清除凭据并断开 |
| pi 侧 | `/qq-send <text>` | 手动向绑定用户发一条测试消息 |
| pi 侧 | `/qq-md [text]` | 诊断：发送 Markdown 消息，验证 C2C markdown 渲染能力 |
| pi 侧 | `/qq-stream-test` | 诊断：开流→三帧→complete，验证流式帧是否渲染 |
| QQ 侧 | `/new` `/stop` `/compact` `/status` `/help` | 会话控制（见 F2） |

## 6. 可靠性与安全

- **生命周期**：`session_start` 启动、`session_shutdown` 幂等关闭；SDK 默认无限重连（退避 1s→60s），4914/4915 致命关闭码上报为不可恢复，提示重新 `/qq-login` 或检查凭据。
- **回声与去重**：启用 SDK `messageFilter`（跳过 bot 回声）与 `concurrencyGuard`（同用户串行），避免流式与回复互相踩踏。
- **安全**：
  - 凭据文件 `0600`，日志脱敏；扩展以 pi 同等权限运行，白名单外的消息不进入 pi（不产生任何工具执行）。
  - QQ 侧无 shell 类命令；一切工具执行都经由 pi 自身权限体系。

## 7. 决策记录

| # | 问题 | 决策 |
| --- | --- | --- |
| 1 | TUI 二维码渲染 | 登录协议用 connector；展示用 `qrcode-terminal`（零依赖）在 `ctx.ui` 弹窗画码 |
| 2 | thinking 内容 | 不回传具体内容（始终剔除，无配置开关）；F7 时间线中仅以"💭 思考中…"标记体现 |
| 3 | tool 消息 | **完全不回传**（从功能范围移除；只回传 assistant 消息 + token usage + 上下文占比） |
| 4 | 图片方向 | F3 为 QQ → pi（用户发图给 pi）；pi 不向 QQ 发图片（LLM 仅输出纯文本） |
| 5 | 成本展示 | `usage.cost.total` 随用量摘要一并回传 |
| 6 | 回复格式 | 回复通常为 Markdown 格式的总结/提问文本（不在回复中写代码）；默认轻量转纯文本，有 markdown 权限可透传 |
| 7 | 登录方式 | 双通道：`~/.pi/agent/pi-qq.json` 存在 `AppID`/`AppSecret` 即免扫码直连，否则扫码登录；凭据统一存该文件 |
| 8 | 长任务反馈 | 开始确认 + typing 保鲜 + 节流心跳（默认 10 分钟/条，流式载体优先，每 run ≤3 条消息心跳保险丝）+ 机会性流式（平台拒绝即降级） |
| 9 | 流式可用性（实测三轮） | ① C2C markdown（msg_type=2，`sendMarkdown`）渲染正常；② SDK 内置流式 `input_mode="replace"` 被平台拒绝（"已经提交的消息内容不可修改"），首帧可渲染、后续帧报错；③ 自实现 `AppendStream`（input_mode="append"，增量追加 + DONE）实测通过；补齐节流合帧（500ms）与限流退避重试后**默认开启**，失败自动降级消息路径 |

## 8. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1 | F1 登录接入（配置直连 + 扫码登录）+ 凭据持久化 + 连接启动 | 配置直连或扫码后 `/qq-status` 显示在线 |
| M2 | F2 单人聊天 + F4 assistant 回传（先非流式） | QQ 发消息得到 pi 回复 |
| M3 | F5/F6 用量摘要（token + 成本 + 上下文占比） | 用量摘要消息正确呈现 |
| M4 | F4 流式模式 + F3 QQ 图片消息 + 降级策略打磨 | 长回复流式、图片可进入 pi 会话 |
