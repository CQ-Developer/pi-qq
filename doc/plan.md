# pi-qq 1.7.3 修复计划

> 状态：待实施
> 日期：2026-11-27
> 依据：2026-11-24–27 真实日志（138,137 行 / 32 MiB）
> 关联：`doc/todo.md`、`doc/archive/delivery.1.7.2.md`

## 1. 范围

本次修复处理日志分析确认的 4 项问题，按风险排序：

| 优先级 | 问题                                                 | 目标                                                    |
| ------ | ---------------------------------------------------- | ------------------------------------------------------- |
| P1     | SDK `Dispatch event` 日志包含完整正文                | 只保留事件类型和 payload 长度                           |
| P1     | `40054005` 后 `40034019` 被当作可恢复错误反复 resume | 按“流已结束”开新流、`index=0`、重放未确认缓冲           |
| P2     | event-loop 每 5 s 记录，占日志 2.7–6.0%              | 改为 30 s 采样，保留基线并减少约 83% 日志               |
| P2     | 空闲期 `outbound` 被门控，`/status` 回复无日志       | `outbound` 常驻，仅记录 `targetId`、`msgId`、长度、模式 |

不在本次范围：

- 超长 bash 命令的 QQ 客户端折叠（已人工确认正常，不再跟踪）。
- 1 小时以上的 `msg_id`、账号/地区/客户端差异（长期观察）。
- `40034020` 在真实网络抖动、重连、限流下的恢复（继续观察）。
- 修改 QQ 协议、SDK 或流式帧格式。

## 2. P1-1：阻止 SDK dispatch 正文进入日志

### 现状

`src/infra/file-logger.ts` 的 `summarizeSdkMessage()` 只截断 `Body: `，SDK 的
`Dispatch event: t=C2C_MESSAGE_CREATE payload={...}` 会完整保留 `content`、消息 ID、
头像 URL 等信息。本批日志有 8 行 dispatch，其中 2 条是真实用户文本。

### 实现

1. 在 `summarizeSdkMessage()` 中识别 `Dispatch event:` 后的 `payload=`：
   - 保留 `[id] Dispatch event: t=<TYPE>` 前缀。
   - 将 payload 替换为 `payload=<N chars>`，N 为原始 payload 字符数。
   - 仅处理 `Dispatch event:` 行，避免误伤普通文本中的 `payload=`。
2. 保持 `Body: ` 现有逻辑不变。
3. 不改变 `bot` scope 的 `inboundMessage` 元数据日志；ID 仍按现有规则哈希。

### 测试

`test/infra/file-logger.test.ts` 新增：

- `C2C_MESSAGE_CREATE` payload 含 `content:"secret"`：日志不含 `secret`，含
  `payload=<N chars>`，保留 `t=C2C_MESSAGE_CREATE`。
- `RESUMED payload=""` 和空 payload 不抛错。
- 普通消息不含 `Dispatch event:` 时不被截断。
- 现有 `Body:` 摘要测试继续通过。

### 验收

- `npm test -- test/infra/file-logger.test.ts`
- 真实 QQ 收一条消息后，日志中不再出现 `content` 正文；`Dispatch event` 仍可用于
  关联事件类型和时间。

## 3. P1-2：`40034019` 的流恢复

### 现状

`src/relay/bubble-writer.ts` 的 `isExpiredStreamError()` 只识别 `40034020`。
`40034019`（流式引导已经结束）被当作普通错误，`handleStreamError()` 用 checkpoint
resume 同一个 `stream_msg_id`；两次失败后 `killStream()`。

本批日志：9 次 `40054005`，其中 7 次随后出现 `40034019`，4 个 run
`delivered=false`。最终文本可回退普通消息（本批 3 个 run 可见），但流式工具输出丢失。

### 实现

1. 在 `bubble-writer.ts` 增加独立的 `isEndedStreamError()`，识别 `40034019`（错误码或“流式引导已经结束”消息）；
   `isExpiredStreamError()` 继续只识别 `40034020`。
2. `handleStreamError()` 中把 `resetSeq || expired || ended` 统一走“开新流”路径：
   - 丢弃 `streamMsgId` 和 `msgSeq`；
   - `index=0`；
   - 保留未确认的 `buffer`。
3. 复用现有 `AppendStream` 的 `resume`（无 `stream_msg_id`）路径，不改
   `stream-session.ts`。
4. `resumeAttempts` 上限和 `killStream()` 不变；新流仍失败时继续走现有
   `/last` / 普通文本回退（自动重绑仍只针对 `40034020`）。
5. 日志增加 `ended` 字段，保留现有 `expired` 字段，避免破坏已有日志分析。

### 测试

- `test/relay/bubble-writer.test.ts`：新增 `40034019` 用例，断言新流
  `index=0`、无 `stream_msg_id`、`msg_seq` 变化、缓冲重放、`writer.dead=false`。
- `test/relay/run-stream-relay.test.ts`：新增 `endedNext` 注入，断言
  `streamContent` 完整、`delivered=true`，且不会触发自动重绑。
- 回归现有 `40054005`、`40034020` 用例。

### 真实 QQ 验证

1. 用临时实验扩展制造一次 `40034019`：向已 DONE 的 `stream_msg_id` 再发一帧。
2. 观察 relay 是否丢弃旧流、开新流、`index=0`、重放缓冲并收到 200。
3. 若平台在 `40034019` 后拒绝同 `msg_id` 新流，保留当前 kill 路径，并在 TODO
   记录“平台级终止”；不要为了重试无限开流。

### 风险

- `40034019` 可能是 `msg_id` 级终止而不是流级终止；受 `MAX_RESUME_ATTEMPTS` 限制，
  最多多出两次新流尝试，失败后仍回退。
- 不要把它并入 `40054005` 的 `resetSeq` 分支；两者语义不同。

## 4. P2-1：event-loop 降频

### 现状

`index.ts` 每 5 s 记录一次；本批 8805 行 / 1.72 MiB，占 2.7–6.0%。`maxMs` p50
21–23 ms，>100 ms 仅 16 次，>500 ms 为 0。真实长日志中 qqbot/stream/run 已占
37%/25%/23%，event-loop 不是主要项，但绝对量仍可压缩。

### 实现

1. 将采样间隔改为 30 s，使用单一常量 `EVENT_LOOP_INTERVAL_MS`。
2. `driftMs` 基准改为 `now - lastTickAt - EVENT_LOOP_INTERVAL_MS`。
3. 保留 `meanMs`、`maxMs`、`p99Ms`、`driftMs`、`utilizationPercent` 字段，不新增
   字段。

备选方案：保留 5 s，但仅记录 `maxMs >= 100 || driftMs >= 50`。该方案保留约 0.2%
日志，但丢失基线；不推荐单独使用。

### 验收

- 11 分钟 run 的 event-loop 行数从约 133 降到约 22。
- 30 s 采样仍能捕获 >100 ms 的尖峰；若需要更细粒度，临时调回 5 s 复测。

## 5. P2-2：`outbound` 常驻

### 现状

`index.ts` 的 log gate 只在 run 活跃时放行 `outbound`。本批 3 次 `/status` 中，
run 内 2 次有发送日志，空闲期 1 次完全没有，无法排查命令回复。

### 实现

1. `index.ts` 的 gate 回调增加 `if (scope === "outbound") return true;`。
2. `qqbot` 仍只在 run 活跃时放行，避免 SDK 请求日志常驻。
3. 保持现有字段：`targetId`、`msgId`、`length`、`mode`；不记录回复正文。

### 测试

- `test/index.test.ts` 扩展 gate 测试：无 run 时 `outbound` 记录可见，
  `stream`/`qqbot` 仍隐藏。
- 真实 QQ 在空闲期发送 `/status`，确认 `sending text chunk` / `text chunk sent`
  落日志，且无正文。

### 风险

- 日志略增；`targetId` 是 openid，仍属敏感 ID，沿用现有日志脱敏和本地保存策略。

## 6. 实施顺序

1. P1-1 日志正文（小改动、可单测、隐私风险最高）。
2. P1-2 `40034019` 恢复（先单测，再真实 QQ 验证）。
3. P2-1 event-loop 降频。
4. P2-2 `outbound` 常驻。
5. 全量验证、更新 CHANGELOG、发布 1.7.3。

## 7. 验证与发布

自动化：

- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run format:check`
- `npm run pack -- --dry-run`

真实 QQ：

- P1-1：任意一条用户消息不再把正文写入日志。
- P1-2：制造 `40034019`，确认新流、重放、DONE 200；至少验证一次失败回退。
- P2-1：一次 10 分钟以上 run 的 event-loop 约每 30 s 一行。
- P2-2：空闲 `/status` 的发送元数据可见。

发布按 `AGENTS.md`：bump 版本、更新 `CHANGELOG.md`、打 `v*` tag、push；CI 负责
npm publish 和 GitHub Release，不手工发布。

## 8. 待确认

- 目标版本是否定为 `1.7.3`。
- `40034019` 在真实 QQ 上是否接受同 `msg_id` 新流；若不接受，是否只保留普通文本
  回退和 `/last`。
- event-loop 采用固定 30 s，还是 30 s + 超阈值双策略。
