# 2026-11-19 真实使用日志分析与决策

> 工作文档，逐项讨论用。讨论结束后，结论并入 `doc/todo.md` 或交付记录，本文件删除。
> 数据来源：`pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-19.log`（不入库）
> 记录日期：2026-11-19
> 相关版本：1.7.1
> 结论：功能与 API 正常；主要问题集中在日志体积、日志标识与诊断字段；另有 3 项需要产品/测试决策。

## 1. 摘要

| #   | 项目                                  | 优先级 | 类型        | 预估收益/影响                        | 状态     |
| --- | ------------------------------------- | ------ | ----------- | ------------------------------------ | -------- |
| T1  | 短 ID 方案（`slice(0,8)` 失效）       | P1     | 隐私/可追踪 | 统一 79 行完整 ID 与 7,571 行常量 ID | 已实现   |
| T2  | 诊断行去掉完整 `tools` 数组           | P1     | 体积        | −46%（约 3.5 MiB）                   | 已实现   |
| T3  | 无文本的 takeover 决策不记录          | P2     | 体积        | −233 行 / 约 0.8 MiB                 | 已实现   |
| T4  | 流式每帧 debug 降级                   | P2     | 体积        | 最多 −1.7 MiB（22%）                 | 已实现   |
| T5  | `append elapsed` 初值伪值             | P2     | 缺陷        | 438 行噪声                           | 已实现   |
| T6  | `bubble split` 记录时机与原因         | P2     | 缺陷        | 421 行不可归因                       | 已实现   |
| T7  | `run ended` 计数恒为 0、早于最终 DONE | P2     | 缺陷        | 诊断误导                             | 已实现   |
| T8  | event-loop 指标基线偏移               | P3     | 缺陷        | 指标不可用                           | 已实现   |
| T9  | 重复日志行                            | P3     | 体积/噪声   | 约 530 行，含 tool 诊断体积的一半    | 已实现   |
| T10 | 本地被动额度不统计流式气泡            | P1     | 产品        | 438 个气泡未受 `limit=4` 约束        | 已文档化 |
| T11 | 气泡碎片化                            | P2     | UX          | 438 个消息 / 43 分钟，12% <100 字符  | 已文档化 |
| T12 | 600 s 过期路径未被真实覆盖            | P2     | 测试        | 最长气泡 208 s                       | 待验证   |
| T13 | `/status` 未返回电量                  | P1     | 缺陷        | 已确认 `ETIMEDOUT`（520 ms）         | 已实现   |

## 2. 数据摘要

- 会话跨度 7 h 01 min（00:41:54–07:42:50 UTC），活跃 agent 时间 43.0 min。
- 18 条入站 / 17 个 run / 246 次工具调用；1 次 `/status`（run 中到达，0.7 s 回复）。
- 1,940 次 POST（1,922 流式 + 18 文本），**1,941 次响应全部 200**；无 `40034xxx`、重试、DONE 失败。
- 流式 API RTT p50 354 ms / p99 650 ms；文本 p50 534 ms；`waitedMs` p50 0。
- 438 个流式气泡，寿命 p50 2.5 s / p99 66 s / max 208 s；单 run 2–146 个。
- 6 次 WebSocket 重连（约每小时，attempt 1，约 1.8 s 恢复），其中一次在流中途，流未中断。
- 日志：18,452 行 / 7.64 MiB（约 10.6 MiB 每活跃小时）。
- 内容脱敏成立：无正文、参数、结果、SDK body。

## 3. 讨论项

### T1 短 ID 方案

**证据**

- `logMsgId()` 取 `messageId.slice(0, 8)`，QQ 消息 ID 统一以 `ROBOT1.0` 开头：7,571 行 `msgId` 全部是 `ROBOT1.0`，无法关联到具体入站消息。
- 同时 `inbound` / `bot` / `session` 的 79 行仍保留完整 `messageId`（117 字符）、`senderId`、`allowedOpenid`、`appId`。
- `streamMsgId` 记录完整 UUID，与 `msgId` 策略不一致。

**问题**：当前的“短 ID”既没有追踪价值，也没有隐私收益。需要确定短 ID 的生成方式，以及哪些 ID 保留完整值。

**选项**

- A（推荐）：新增 `shortId(id)`，取 `_` 之后的 8 位（如 `UMkNSaLL`）；无 `_` 时取首 4 + 末 4。用于 `messageId` / `streamMsgId`；`senderId` / `appId` 保留完整值，因为它们是稳定账号标识、只存本地、用于区分账号。
- B：所有 ID 一律首 4 + 末 4 掩码，包括 `openid`。
- C：保持现状，只在文档声明“日志仅本地”。

**建议**：A。A 同时满足隐私与排查；B 会降低多账号排查能力；C 的问题是不可追踪。

**验证发现（2026-11-19 真实日志）**：A 的“取 `_` 后 8 位”仍不可用。QQ 消息 ID 的结构是
`ROBOT1.0_` + 21 字符固定头 + 中间变化段 + 约 35 字符固定尾；不同消息的 `_` 后前 8 位都是
`UMkNSaLL`，末 8 位也大多是 `QpRmBmM`。只有中段变化，所以任何贴边切片都会碰撞。

**修订（A′）**：`shortId()` 改为 `sha256(id)` 的前 8 位十六进制（如 `a98bf36d`）。同一 ID 在所有
scope 中得到同一短值，不再泄露原值，也不受平台 ID 布局影响。日志层只对长度 ≥16 的 ID 字段做哈希，
避免对已经是短值的字段重复哈希。

**改动范围**：`bubble-writer.ts`、`run-stream-relay.ts`、`index.ts`、`qq-message-handler.ts`、
`file-logger.ts`、`short-id.ts`；新增单测覆盖固定头/尾但不同消息的情况。

### T2 诊断行去掉完整 `tools` 数组

**证据**

- `tools` 字段单独占 3.51 MiB（46.0%），分布在 1,254 行；单行最大 11.1 KiB（86 个工具）。
- `run: tool start` 1,830 KiB + `run: tool end` 1,829 KiB + takeover 927 KiB。
- `tools` 来自 `RunTimeline.diagnostics()` 的 `this.tools.map(...)`，与该类已有的 `snapshot()`（最多 5 个）不一致。

**问题**：`tools` 的目的是定位“哪个工具卡住”，`activeTool` + `toolCount` + `pendingToolCount` 已足够；完整列表只增加体积。

**选项**

- A：删除 `tools`，只保留 `activeTool` / `toolCount` / `pendingToolCount`。
- B（推荐）：改为最近 3 个已完成 + 活动工具（复用 `snapshot()`），映射时排除 `args` / `result.result`，只保留 `id` / `name` / 状态。
- C：只在 `run ended` 记录完整列表。

**建议**：B。保留少量上下文，单行从 3.8–11 KiB 降到约 0.7 KiB，预计节省 3.0–3.2 MiB。

### T3 无文本的 takeover 决策不记录

**证据**

- `streamTakeoverDecision` 253 行中 233 行 `textLength=0`（纯 toolCall，没有可接管内容），占约 0.8 MiB。
- 已有 `assistantMessageNoText` 记录同一事实。

**问题**：这些行只说明“没有文本，不需要接管”，没有决策信息。

**选项**

- A（推荐）：仅当 `textLength > 0` 或 `streamTookOver=false` 时记录。
- B：全部保留，作为计数依据。
- C：降为 trace 级。

**建议**：A。保留 20 行有文本的决策 + 1 行非接管决策；如需统计无文本次数，`assistantMessageEnded` 已覆盖。

### T4 流式每帧 debug 降级

**证据**

- `stream` scope 1.67 MiB（22%），7,520 行；其中 `streamTiming` 1,176 行 / 554 KiB，逐帧 `append` / `flush` / `timer` 约 1.1 MiB。
- 单帧平均约 230 B，信息密度低；失败时 `DONE failed` 仍是 warn。

**问题**：逐帧日志只对协议调试有用，日常 debug 不需要。

**选项**

- A（推荐）：保留 `flush: done` 的异常/慢帧（>1 s 或 `remaining>0`），删除逐帧 `append: buffered/immediate`、`flush: start`、`timer: fired`。
- B：引入独立 `logLevel: "trace"`，默认不写。
- C：保持现状。

**建议**：A 先做（改动小），若仍需要协议排查再考虑 B。预计节省 1.0–1.3 MiB。

### T5 `append elapsed` 初值伪值

**证据**

- 1,375 条 `append` 中 438 条（32%）为 `elapsed=1795049015062`（约 1.795e12 ms）。原因是 `lastFlushAt` 初始为 0，`Date.now() - 0`。
- 其它 18 条 >10 s、919 条正常。

**选项**

- A（推荐）：`lastFlushAt === 0` 时记为 `elapsed=first`（或省略该字段）。
- B：构造时初始化 `lastFlushAt = Date.now()`。

**建议**：A。B 会把“距离上次 flush”变成“距离创建”，语义错误。

**实施**：随 T4 一起删除了 `append` 逐帧日志，`elapsed` 不再有输出路径，本项无剩余改动。

### T6 `bubble split` 记录时机与原因

**证据**

- 421 行 `bubble split` 的 `stats` 全为 0（`bubbleChars=0`、`hasStream=false`），因为日志在重置字段之后记录；且没有 `reason`。
- 分裂频率高（每 run 2–146 次），无法区分工具边界、thinking/text 切换、超长切分或重启。

**选项**

- A（推荐）：在重置前捕获 `bubbleChars` / `lastKind`，并给 `rotateStream(reason)` 传入 `tool|text|thinking|skill|restart|oversize`。
- B：只修正记录时机，不加 `reason`。

**建议**：A。`reason` 是后续评估 T11 的数据基础；改动集中在 `bubble-writer.ts` 的 6 个调用点。

### T7 `run ended` 计数恒为 0、早于最终 DONE

**证据**

- 同一时刻的 takeover 行显示 `finalizedTextLen=980 / resultSentLen=980`，而 `run ended` cleanup 行为 0 / 0：`onAssistantMessageEnd` 在记录前已重置。
- `run ended` cleanup 记录发生在 `writer.flush()` / `done()` 之前（已知问题，TODO 3 已列）。

**选项**

- A（推荐）：在 run 上保留 `lastFinalizedTextLen` / `lastResultSentLen` 快照供 cleanup 使用；把 cleanup 日志移到 `flush/done` 之后，或改名为 `phase: "cleanup start"` 并另记 `phase: "disposed"`。
- B：只修计数，不动日志顺序。

**建议**：A。两项都会影响排障判断，一起修。

### T8 event-loop 指标基线偏移

**证据**

- 516 个样本 p50=112 ms、p90=114 ms、p99=120 ms，与日志量相关系数 0.007：几乎恒定，不符合真实阻塞分布。
- 本机 Node 24 复现：`resolution` 为 1/10/100 时，空闲基线分别约 1/10/100 ms，即 `mean` 存在约等于 `resolution` 的固定底噪；`resolution: 100` 解释了日志中的 ~112 ms。
- 真实增量约 13 ms；仅 2 次尖峰（363 / 617 ms）。

**选项**

- A（推荐）：`resolution: 1`，并在日志中同时记录 `eventLoopUtilization()` 作为交叉验证。
- B：只记录已有的 `driftMs`（本次均值 6.2 ms）和 `maxMs`，删除 `mean/p99`。
- C：保持现状，文档注明基线。

**建议**：A。改动一行；需在 Windows 环境确认基线同样为 ~1 ms。

### T9 重复日志行

**证据**

- 每次工具事件 2 条时间差 1–2 ms 的 debug（`queued` / `output started`，`result recorded` / `output finished`），共 984 行，占 T2 体积的一半。
- 每条入站 2 条 `messageReceived`：一条 debug 全量、一条 info 精简（实现时修正：不是两条 debug）。
- 每个 run 另有 `agent` scope 的 info `run started` / `run ended`，以及 `run` scope 的 debug 行；两者服务不同 `logLevel`（info 级别不写 debug），不是纯重复，应保留。

**选项**

- A（推荐）：合并 tool start/end 为每次转型一行；`run ended` 的 debug cleanup + finished 合并（见 T7）；`messageReceived` 合并为一条 info 全量（在 allowlist 检查后）；`agent` info 行保持不变。
- B：只合并 tool 行（收益最大的一项），其余保留。
- C：保持现状。

**建议**：A，改动机械但涉及多个日志点；与 T2、T7 同一次提交完成，便于统一验证。

### T10 本地被动额度不统计流式气泡

**证据**

- `totalReplies=1`（仅 `/status` 的文本回复），`remaining` 全程 4（之后 3）；而 `streamBubblesTotal` 达 93，单 run 438 个气泡中的 146 个。
- `noteStreamBubble()` 只计数，不 `commitPassive()`；`limit=4` 实际只约束非流式文本。
- 本次 1,941 次请求全部 200，没有 `40034128`。

**问题**：需要明确这是有意设计还是遗漏。若平台未来对流式消息计费/限流，当前本地保护不足；若平台本就不计流式，则 `remaining` 的展示会误导。`/status` 的 `estimated` 行已经用 `remaining - streamBubbles` 做了保守估计（本次会显示 0），但 `passiveRemaining` 仍显示 4（或 3），两者含义不同且未说明。

**选项**

- A（推荐）：保持“流式不计入 limiter”，在 `doc/todo.md` / README 说明该假设；`/status` 把 `passiveRemaining` 标注为“仅文本回复”，并保留 `estimated` 作为保守值。
- B：`noteStreamBubble()` 同时 `commitPassive()`，让 `remaining` 反映全部气泡；代价是 4 个气泡后的文本回复会转 proactive。
- C：新增独立流式上限（如每 run 60 / 每分钟 10），超限合并或降级。
- D：只加告警（`streamBubbles` 超过 `remaining` 时写一条 warn），不改行为。

**建议**：A + 观测。平台本次 1,941 次请求全部 200；先补文档与指标，出现 `40034128` 再考虑 C。B 会改变真实回复路径，D 的告警在当前日志中会频繁触发且没有可执行动作。

### T11 气泡碎片化

**证据**

- 438 个气泡 / 43 分钟，约 8 个/分钟；单 run 最多 146 个。
- 气泡大小 p50 442 字符、p90 2,096、max 11,964；12%（47 个）<100 字符。
- `pushTool()` 在 `lastKind !== "none"` 时强制新气泡，每个工具行单独一条消息。

**问题**：`replyType=full` 下这是有意行为，但 100 字符以下的工具行单独成消息，可能造成打扰。

**选项**

- A（推荐）：保持默认行为，在 README 说明 `full` 的消息密度；不改实现。
- B：短工具行（<100 字符）并入当前气泡，不单独开新气泡。
- C：新增 `replyType: "compact"`（工具行合并、结果独立）。

**建议**：A 先观察；若真实用户反馈打扰，再评估 B（改动小、只影响短工具行）。需要真实 QQ 体验判断，日志无法替代。

### T12 600 s 过期路径未被真实覆盖

**证据**

- 438 个气泡寿命 p99 66 s、max 208 s；本次 0 次 `40034020`。
- 高频轮换（工具边界即换气泡）使单气泡很难接近 600 s，因此长生命周期恢复逻辑没有被真实流量覆盖。
- TODO 2 的“超过 20 分钟 `msg_id`”仍未验证。

**选项**

- A（推荐）：保留 TODO 2，补一项受控测试：单个长静默工具（不产生中间输出）持续 11 分钟，覆盖 600 s 边界与自动新开流。
- B：接受“轮换足够频繁，不需要过期路径”的结论，删除相关代码与测试（不建议，网络抖动下仍需兜底）。

**建议**：A。现有单测已覆盖逻辑，但真实 QQ 的 600 s 边界仍需至少一次端到端验证。

### T13 `/status` 未返回电量

**现象**

- 2026-11-19 01:39:29.707 收到 `/status`；01:39:30.220 发出文本，间隔 513 ms；回复 177 字符。
- 日志只记长度、不记正文，无法从日志确认缺少哪一行。

**代码路径**

- `getStatusLines()` 同步调用 `getPowerStatus()`；Windows 分支为 `execFileSync("powershell", [...], { timeout: 500 })`，异常被 `catch` 静默吞掉（`src/infra/power-status.ts`）。
- 513 ms 与 500 ms 超时高度吻合：PowerShell 冷启动加 `Get-CimInstance Win32_Battery` 常见耗时超过 500 ms。
- 另一种可能：查询返回空（如台式机/无电池），`ConvertTo-Json` 输出为空串 → `JSON.parse` 失败 → 同样无电量行；此时耗时应远小于 500 ms。

**诊断结果（2026-11-19）**

- `/status` 完全不显示电量行。
- 用当前代码参数复现：`ERR ETIMEDOUT SIGTERM`，`elapsed_ms=520`。确认是 500 ms 超时终止了 PowerShell，不是“无电池”。
- 长超时复测：成功返回 `{"EstimatedChargeRemaining":100,"BatteryStatus":2}`，`elapsed_ms=669`；3 s timeout 足够。

```powershell
node -e "const{execFileSync}=require('child_process');const t=Date.now();try{console.log(execFileSync('powershell',['-NoProfile','-Command','Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'],{encoding:'utf8',timeout:10000}))}catch(e){console.log('ERR',e.code,e.signal)}console.log('elapsed_ms=',Date.now()-t)"
```

**候选方案**

- A：timeout 500 → 2000 ms，保持同步；失败时用 debug 记录原因。
- B（推荐）：改为异步 `execFile`（promisify）+ 30 s 缓存，timeout 3000 ms；`getStatusLines()` 改为 async。两个调用点都已在 async handler 中，改动小，且不再阻塞事件循环。
- C：启动/登录后后台异步取一次，60 s 刷新；`/status` 只读缓存。需要新增定时器与生命周期管理。
- D：保留现状，文档注明 Windows 依赖 PowerShell。

**建议**：B。本次 `/status` 就发生在 17.5 分钟的长 run 中，同步等待会直接拖慢流式帧；A 只是把最多 2 s 的阻塞保留下来，C 对一个低频命令过重。失败时用 debug 记录 `platform` 与错误码，避免再次静默。

## 4. 决策记录

| #   | 决定                                                                                                                               | 日期       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| T1  | A：新增 `shortId(id)`，取 `_` 后 8 位（无 `_` 时首 4+末 4），用于 `messageId` / `streamMsgId`；`senderId` / `appId` 保留完整       | 2026-11-19 |
| T2  | B：`diagnostics()` 复用 `snapshot()` 的最近 3 个已完成 + 活动工具（≤5 个），显式映射，不带 `args` / `result`                       | 2026-11-19 |
| T3  | A：仅当 `textLength > 0` 或 `streamTookOver=false` 时记录决策                                                                      | 2026-11-19 |
| T4  | A：删除逐帧 `append` / `flush: start` / `timer` / 常规 `flush: done`；保留聚合 `streamTiming`、慢帧与 warn                         | 2026-11-19 |
| T5  | A：`lastFlushAt === 0` 时记录 `elapsed=first` 或省略字段                                                                           | 2026-11-19 |
| T6  | A：重置前记录 `bubbleChars` / `lastKind`；`rotateStream(reason)` 透传 `thinking` / `text` / `tool` / `skill` / `split` / `restart` | 2026-11-19 |
| T7  | A：保留 `lastFinalizedTextLen` / `lastResultSentLen` 快照；cleanup 日志移到 `flush/done` 之后并与 `finished` 合并                  | 2026-11-19 |
| T8  | A：`resolution: 1`，并同时记录 `performance.eventLoopUtilization()`                                                                | 2026-11-19 |
| T9  | A：tool start/end 各合并为一行；`messageReceived` 只保留字段更全的一条；`agent` info 行保持不变                                    | 2026-11-19 |
| T10 | A：保持流式不计入 limiter；`passiveRemaining` 标注“仅文本回复”，保留 `estimated`；README/todo 说明假设                             | 2026-11-19 |
| T11 | A：保持默认行为，仅在 README 说明 `full` 模式的消息密度                                                                            | 2026-11-19 |
| T12 | A：保留 TODO 2，补一次约 11 分钟长静默工具的受控真实验证                                                                           | 2026-11-19 |
| T13 | B：改用异步 `execFile` + 30 s 缓存，timeout 3000 ms；`getStatusLines()` 改 async；失败记 debug（platform + 错误码）                | 2026-11-19 |

## 5. 实施记录

| 提交                      | 内容                                                                                               | 覆盖        |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ----------- |
| `98df2df` `refactor(log)` | 短 ID、`tools` 摘要、takeover 过滤、逐帧日志精简、split 归因、runEnded 合并、event-loop 指标、去重 | T1–T9       |
| `0d6c759` `fix(power)`    | 异步电量探测、3s timeout、30s 缓存、失败日志                                                       | T13         |
| 本次 `fix(log)` 提交      | 短 ID 改为 SHA-256 前 8 位，修复固定头/尾导致的碰撞                                                | T1 修订     |
| 本次 `docs` 提交          | README/todo、`/status` 文案、T9 证据修正                                                           | T10/T11/T12 |

验证：`npm test` 通过、`tsc --noEmit`、`lint`、`format:check` 通过。

真实 QQ 验证（2026-11-19，11 分钟静默工具）：旧流在 660s 返回 `40034020`，`expired: true`；
新流 `resumed: true`、`index=0`、无 `stream_msg_id`、重放 17 字符缓冲；工具结果与最终 `OK` 均送达；
`run ended` 为 `delivered: true`。日志 188 行 / 43.6 KiB，无逐帧 append/flush，电量显示 99%。

待验证：T12 的 11 分钟长静默工具需在真实 QQ 上执行；T1–T9、T13 需用下一次真实日志确认体积与可读性。

## 6. 后续

- 日志类改动与 T10/T11 文档更新一起发布（建议 1.7.2）。
- T12 的受控测试单独安排，不阻塞日志改动。
- 完成后：结论并入 `doc/todo.md`；交付记录写入 `doc/archive/delivery.<version>.md`；删除本文件。
