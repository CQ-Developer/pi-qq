# pi-qq — plan.md

> 执行计划。功能范围与决策见 [features.md](./features.md)，本文只回答：装什么、建什么文件、按什么顺序做、每步怎么验收。

## 0. 前置：依赖安装（需你手动执行）

按约定不由我安装。在项目目录执行：

```bash
cd /home/chen/project/pi-qq
npm init -y
npm i @tencent-connect/qqbot-nodejs @tencent-connect/qqbot-connector qrcode-terminal
```

| 包 | 版本锚点 | 用途 |
| --- | --- | --- |
| `@tencent-connect/qqbot-nodejs` | ^1.0.5 | QQ 协议层（本地另有源码 `/home/chen/project/qqbot-nodejs` 可查阅） |
| `@tencent-connect/qqbot-connector` | ^1.2.0 | 扫码登录（方式 B） |
| `qrcode-terminal` | ^0.12 | 二维码 ASCII 渲染（零依赖） |

开发加载方式：`pi --extension /home/chen/project/pi-qq`（jiti 直接跑 TS，无需构建）。

## 1. 目录结构与模块划分

```
pi-qq/
├── package.json
├── tsconfig.json          # 仅编辑器/typecheck 用，无构建
├── index.ts               # 扩展入口：registerCommand + pi.on 订阅 + 生命周期
└── src/
    ├── config.ts          # ~/.pi/agent/pi-qq.json 读写（0600、schema 兼容大小写、字段合并）
    ├── login.ts           # F1：方式 A 直连判定 / 方式 B 扫码（connector + TUI 二维码弹窗）
    ├── bot.ts             # QQBot 实例生命周期：start/stop、中间件装配、重连/致命关闭码上报
    ├── inbound.ts         # F2/F3：白名单 → QQ 命令拦截 → 图片下载转 ImageContent → sendUserMessage
    ├── outbound.ts        # F4：markdown→纯文本转换、流式(openStream)/降级(sendText)、分块
    ├── reply-budget.ts    # §3：被动回复预算（msgId 5min 窗口、4条/h、降级主动发送）
    └── usage.ts           # F5/F6：会话累计（getBranch 重建）、agent_end 用量摘要（token+成本+上下文占比）
```

职责边界：`index.ts` 只做装配与订阅，不含业务逻辑；每个模块可独立测试；模块间只经 `index.ts` 传递的共享状态对象（bot 实例、当前 target/msgId、配置）通信。

## 2. pi 事件与 SDK 接线总表

| 方向 | 信号 | 处理 |
| --- | --- | --- |
| QQ → pi | `bot.on("message")`（kind=c2c） | 白名单 → QQ 命令（`/new` `/stop` `/compact` `/status` `/help`）→ 文本+图片 → `pi.sendUserMessage()` |
| pi → QQ | `message_update`（assistant） | 流式：`openStream().update(转换后全文)`，节流 ≥300ms |
| pi → QQ | `message_end`（assistant） | `stream.complete()`；无流上下文时 `sendText`；`stopReason==="error"` 回错误摘要 |
| pi → QQ | `agent_end` | 用量摘要一条（F5 token+成本 + F6 上下文占比） |
| 状态 | `session_start` / `session_shutdown` | 读配置启动 bot（A→B 判定）/ 幂等停止 |
| 记录 | `session_start` 重建累计用量；`/new` 清零 | `sessionManager.getBranch()` |

## 3. 里程碑

### M1 — 登录接入与连接（F1 + bot.ts + config.ts）

1. `package.json`、`tsconfig.json`、目录骨架；`config.ts`：读取/写入 `~/.pi/agent/pi-qq.json`（`AppID`/`AppSecret` 大小写兼容、其余字段合并保留、0600）。
2. `bot.ts`：`createBot(credentials)`、`start/stop`、装配 `messageFilter`（回声过滤）+ `accessPolicy`（白名单）+ `concurrencyGuard`；`ready/disconnected/error` 上报到 `ctx.ui`。
3. `login.ts` + `index.ts`：
   - `session_start`：配置有凭据 → 直连（方式 A）；无凭据 → `ctx.ui.notify` 提示 `/qq-login`。
   - `/qq-login`：`startQrConnect`（`displayQrCodeToConsole: false`），`onQrDisplayed` 在 TUI 弹窗画二维码（`qrcode-terminal`），`onSuccess` 写配置并启动。
   - `/qq-status`（登录方式/来源/绑定用户/连接状态）、`/qq-logout`。

**验收**：手写配置文件启动后 `/qq-status` 显示在线；删掉凭据走扫码后同样在线；`4914/4915` 致命关闭码给出明确提示。

### M2 — 单人聊天与完整回复（F2 文本 + F4 非流式 + reply-budget.ts）

1. `inbound.ts`：C2C 白名单过滤、QQ 命令拦截（`/stop`→`ctx.abort()`、`/new`→`sendUserMessage("/new", { expandPromptTemplates: true })` 或直接清理、`/status` 汇总、`/help`）、文本 → `sendUserMessage`；忙碌时 `deliverAs` 排队。
2. `outbound.ts` 非流式路径：markdown→纯文本转换函数（独立、可单测：强调/标题/列表/链接/表格退化）+ `TEXT_CHUNK_LIMIT` 分块。
3. `reply-budget.ts`：按 `msgId` 记录被动回复次数与 5min 窗口；超限降级主动发送并提示。

**验收**：QQ 发"你好"→ QQ 收到 pi 回复（纯文本、无 markdown 记号残留）；连续对话额度不炸；非绑定用户发消息无任何反应。

### M2.5 — 长任务反馈包（F7，已拍板）

背景：实际场景 `user_input → thinking+tools（10~60 分钟）→ assistant message`，结果只在末尾出现一次。

1. `src/run-feedback.ts`：run 级状态机 —— QQ 触发标记（pending）、工具名×次数计数（`tool_execution_end`）、流会话（`openStream` 惰性开启：首次心跳或首次文本时尝试，失败标 dead）、typing keepalive 定时器（50s）、节流心跳定时器（默认 10min）、消息心跳保险丝（每 run ≤3）、`agent_end` 收尾（complete/cancel/清 timer）。
2. 载体优先级：流式心跳（一条消息持续刷新，0 额度）→ 消息心跳（≤3 条）→ 静默；结果文本在流存活时直接续写同一条流，`message_end` 被流接管时跳过 sendReply（避免双发）。
3. `inbound.ts`：开始确认（idle=开始处理 / busy=并入当前任务）+ `markQQTrigger`。
4. `index.ts`：接线 `agent_start` / `agent_end` / `tool_execution_end` / `message_update`。
5. `config.ts`：`heartbeatMinutes`（默认 10）、`heartbeatMaxMessages`（默认 3）。

**验收**：QQ 发任务 → 立即收确认 → typing 持续 → 心跳按期到达（流或消息）→ 结果回传不双发。

### M3 — 用量摘要（F5 + F6）

1. `usage.ts`：`session_start` 从 `getBranch()` 重建会话累计；`agent_end` 取最后一条 assistant `usage`（本轮）+ 累计 + `ctx.getContextUsage()`（`tokens===null` 显示"重建中"）。
2. 格式：`📊 tokens — 输入 12.3k（缓存命中 11.8k）· 输出 1.2k · 成本 $0.04 · 本轮 2.1k | 上下文 46.5k/200k（23%）`；成本缺失时省略；占比 ≥`contextWarnPercent` 追加"建议 /compact"。
3. 经 reply-budget 发送。

**验收**：每轮对话后 QQ 收到一条摘要，数字与 pi 会话 UI 一致；`/new` 后累计清零。

### M4 — 图片与打磨（F3 + markdownSupport 透传）

1. 流式：`message_update` 接 `openStream`（基于入站 `msgId`，无流上下文自动降级 `sendText`），`message_end` `complete()`；遵守 ≥300ms 节流。
2. `inbound.ts` 图片：`attachments` 下载（超时/`imageMaxSize`/类型校验）→ `ImageContent[]` 与文本一起注入；失败 QQ 提示；模型无视觉能力时提示。
3. 打磨：`/compact` 命令、typing 指示、错误路径（下载失败/ApiError/流中断）全覆盖。

**验收**：长回复在 QQ 中逐步增长；QQ 发图后 pi 能描述图片内容；额度全程不超限。

## 4. 验证策略

- **静态**：`npx tsc --noEmit`（tsconfig 仅类型检查）。
- **单测**（vitest，纯函数优先）：markdown→纯文本转换、分块、reply-budget 状态机、config 读写合并。SDK 与 pi 事件层不做单测，靠 M1–M4 验收手动覆盖。
- **手动验收**：每个里程碑按上表验收项在真实 QQ 环境跑一遍；`baseUrl` 可指向 mock 验证协议路径（SDK 测试有先例）。

## 5. 风险与预案

| 风险 | 影响 | 预案 |
| --- | --- | --- |
| 流式消息对非 C2C/过期 `msgId` 抛错 | 流式路径崩溃 | `openStream` 前置校验，失败即降级 `sendText`（M4 已含） |
| 被动额度耗尽（长 run 多回复） | 消息发不出去 | reply-budget 统一发牌，超限降级主动+提示；摘要固定合并 |
| markdown 转换漏判 | QQ 端残留记号 | 转换函数单测覆盖常见结构；允许透传开关兜底 |
| connector 混淆代码异常 / 扫码接口变更 | 扫码不可用 | 方式 A 直连始终可用（不依赖 connector） |
| pi 事件在非 TUI 模式无 UI | 扩展报错 | 所有 `ctx.ui` 调用前判 `ctx.hasUI`/`ctx.mode` |

## 6. Todo-List（随进度勾选）

### 准备

- [x] 依赖安装：`@tencent-connect/qqbot-nodejs` + `@tencent-connect/qqbot-connector` + `qrcode-terminal`（用户已执行）
- [x] pi / SDK / connector API 签名核对（types.d.ts + 本地源码）
- [x] `package.json` 完善（`type: module`、private、description）
- [x] `tsconfig.json`（`moduleResolution: bundler`；`paths` 借用 pi 发行目录类型 + `typeRoots` 借用其 @types/node，typecheck 走 `npx typescript`，无需安装 devDeps）

### M1 — 登录接入与连接

- [x] `src/config.ts`：`~/.pi/agent/pi-qq.json` 读写（`AppID`/`AppSecret` 大小写兼容、字段合并保留、`0600`、credentials/allowedOpenid 存取）
- [x] `src/bot.ts`：`createBot/start/stop`、中间件装配（messageFilter/accessPolicy/concurrencyGuard）、连接状态跟踪、致命关闭码上报
- [x] `src/login.ts`：方式 A 直连判定 + 方式 B `startQrConnect`（含二维码展示与取消）
- [x] `index.ts`：`/qq-login` `/qq-status` `/qq-logout` 命令 + `session_start` 自动接入 + `session_shutdown` 幂等停止
- [x] 验收：配置直连在线 / 扫码在线 / `4914` `4915` 明确提示（用户实测通过；`4914/4915` 与扫码路径如未触发可在后续使用中观察）

### M2 — 单人聊天与完整回复（非流式）

- [x] `src/inbound.ts`：白名单 → QQ 命令拦截（`/new` `/stop` `/compact` `/status` `/help`）→ 文本 `sendUserMessage` + `deliverAs` 排队
- [x] `src/outbound.ts`：markdown→纯文本转换（独立可单测）+ `TEXT_CHUNK_LIMIT` 分块
- [x] `src/reply-budget.ts`：被动回复预算（5min 窗口 / 4条每小时）+ 降级主动发送
- [x] `message_end`（assistant）非流式回传接线 + `stopReason==="error"` 错误摘要
- [x] 单测：markdown 转换 / 分块 / reply-budget（jiti + assert 脚本 `test/run.ts`，30 项断言；config 12 项在 M1 已验）
- [x] 验收：QQ 发消息→收到纯文本回复；非绑定用户无反应；额度不超限（用户实测通过）

### M2.5 — 长任务反馈包

- [x] `src/run-feedback.ts`：run 级状态机（QQ 触发标记、工具计数、流会话惰性开启、typing/心跳定时器、消息心跳保险丝）+ `formatHeartbeat`
- [x] `config.ts`：`heartbeatMinutes` / `heartbeatMaxMessages`
- [x] `inbound.ts`：开始确认 + `markQQTrigger`
- [x] `index.ts`：`agent_start`/`agent_end`/`tool_execution_end`/`message_update` 接线；`message_end` 流接管判定
- [x] 单测：`formatHeartbeat`（test/run.ts 共 33 项断言）
- [x] 验收：QQ 发任务 → 立即确认 → typing 持续 → 心跳按期 → 结果回传不双发（用户实测通过）
  - 首轮实测（2026-10-28）：确认/typing 正常；SDK 内置流式 replace 语义被平台拒绝（"已经提交的消息内容不可修改"，首帧可渲染、第二帧报错）；C2C markdown 渲染正常（`/qq-md` ✓）。
  - 修复：自实现 `src/append-stream.ts`（input_mode="append"，追加语义），RunFeedback 改为增量追加，`/qq-stream-test` 改测 append 模式。
  - 复验（2026-10-28）：append 两帧 + DONE 全部渲染 ✓，流式链路打通。后续任务：心跳/结果追加需开启 `streamRelay: true`。
  - 时间线升级（用户构想）：流式气泡改为**回合活动时间线**——💭 思考中…（惰性标记，不回传内容）/ 🔧 工具名（tool_execution_start）/ 智能体消息原文（流式增量）依次追加，心跳与 DONE 照旧；帧失败自动降级消息路径并补发未发结果。
  - 汇总帧重构（用户构想）：逐事件追加改为**固定 3s 窗口汇总帧**——思考状态行 + 工具计数行（`[n] 🔧 name`）+ 消息文本增量，按设计稿分组排版；流式帧按 markdown 渲染（实测），故流内传原始文本。用户实测反馈：长思考/长工具期间静默——已加行组帧时间戳 + 空窗口 60s 活性行 + flush 队列串行化（防限流重试与定时器交错）。追加 debug 开关（SDK 日志转终端 + 文本帧时间戳）用于定位用户报告的「超时」现象。
  - 回合独立气泡（用户反馈：内容全压一条气泡太挤）：切分规则改为**每条带文本的 assistant 消息一个气泡**（首版按 message_start 切分产生大量迷你气泡——该模型每轮工具调用都发独立小消息，且 onToolStart 立即行与汇总帧双份报告）。文本驱动边界：新文本 + 当前气泡已含文本 → 封口开新泡；工具并入当前气泡。
  - 二轮实测（2026-10-28，jsonl 事件时间线 vs 气泡时间戳）：3s 汇总节奏准确（事件→帧延迟 0~3s）、无重复、91s 静默区活性行准时（60s 阈值）、markdown 渲染正常。M2.5 全部验收通过。首轮长任务实测三问题：① flushWindow 丢失 resultSentLen 推进导致累计文本重复重发（已修，帧内推进基准）；② 心跳/汇总行补回 💭/🔧 图标；③ 帧节奏实为 3s，观感问题由①导致。
  - 三轮实测（2026-10-29，用户 QQ 截图 + 会话日志）：最终回复被追加 3 份，且最后一个气泡一直停留在“生成中”。根因是 `f806065` 重构丢失两处关键逻辑：① 成功追加文本后未推进 `resultSentLen`，每 3s 汇总帧重发全文；② `sealBubble` 在 `flushWindow` 前捕获旧 `cur`，切泡后新气泡收不到 DONE。修复：追加成功即推进基准；气泡边界仅在上一条文本消息定稿后触发（同消息的流式增量不再切泡）；`sealBubble` 在 flush 后重读 `cur`；错误路径先封口再走消息链路。新增重复/单气泡/双气泡/错误 DONE 回归断言。
  - 四轮实测（2026-10-29，`log/pi.jsonl` + `log/qq.png`）：首条中间文本（工具活动之后的 assistant 消息）被并入活动气泡，未独立成泡。根因：切泡条件要求旧气泡已含文本，而首条文本之前只有思考/工具行组。修复：文本消息首个增量到达时，只要当前气泡已有内容就封口（含仅行组）；工具计数行格式改为 `[n] 🔧 name`（心跳同步），新增活动气泡→文本气泡回归断言。

### M3 — 用量摘要

- [ ] `src/usage.ts`：`session_start` 从 `getBranch()` 重建累计；`/new` 清零
- [ ] `agent_end` 摘要：本轮 usage + 累计 + 成本 + `ctx.getContextUsage()`（`tokens===null` 显示重建中、阈值告警）
- [ ] 摘要经 reply-budget 发送
- [ ] 验收：摘要数字与 pi 会话 UI 一致；`/new` 后清零

### M4 — 流式、图片与打磨

- [ ] `openStream` 流式接线（`message_update` + 300ms 节流 + 无流上下文降级）
- [ ] F3 图片：`attachments` 下载/校验/`ImageContent` 注入 + `imageMaxSize` + 失败提示
- [ ] `/compact` 命令、typing 指示（C2C）
- [ ] 错误路径打磨（下载失败/ApiError/流中断/致命关闭码）
- [ ] 验收：长回复流式；图片进入 pi 会话；全程额度不超限
