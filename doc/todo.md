# TODO

> 2026-11-06 更新：已基于 2026-11-05 / 2026-11-06 的真实使用记录完成首轮分析。TODO 1 的启动帧和参数传递已确认正常；TODO 2 仍未复现，等待真正的多分钟单命令日志。详见各条目的“日志验证结果”。

## 1. 长运行 bash 工具的参数延迟显示

> 状态：启动帧已验证正常；待确认 QQ 客户端渲染
> 记录日期：2026-11-04
> 分析日期：2026-11-06
> 相关版本：pi-qq 1.3.6（仅增加 debug 日志）；本次日志来自 1.4.0 之后的版本

### 现象

正常使用中，bash 执行 e2e 测试通常需要数分钟。此时 QQ 上只能看到 `bash` 和一个点，看不到命令参数；理论上工具名称和参数应该在 `tool_execution_start` 后立即出现，只有结果需要等待工具结束。

### 已知事实

- `AppendStream` 默认有 500ms 节流；这是 pi-qq 自己设置的值，不是 QQ 限制。
- 500ms 定时器不依赖工具 Promise；长工具的启动帧曾在工具结束前通过 `stream_messages` 发出。
- pi 内置 bash 使用异步 `spawn`，正常情况下不会阻塞 Node 事件循环。
- 本地异步子进程可持续触发 500ms timer，说明“bash 子进程本身”不是必然的事件循环阻塞源。
- 2026-11-05 的真实使用记录已覆盖启动帧、`content_raw`、timer/队列和事件循环；但最长单条 bash 只有 94 秒的 docker build，仍没有“数分钟 e2e”样本。分析结果见下文。

### 已经添加的诊断日志

版本 1.3.6 只增加了 debug 日志，没有改变行为：

- `scope: "stream"`，`msgKey: "log.streamTiming"`：
  - `phase: "tool queued"`：工具行进入队列；
  - `phase: "append start"`：队列开始处理，包含 `waitedMs`；
  - `phase: "append done"`：队列处理完成，包含 `totalMs`。
- `AppendStream.onDebug`（同 scope `"stream"`）：
  - `append: buffered/immediate/while flushing`；
  - `timer: fired after ...`；
  - `flush: start/done`。
- `scope: "event-loop"`，`msgKey: "log.eventLoopDelay"`：
  - 每 5 秒记录一次 `meanMs`、`maxMs`、`p99Ms`。

所有日志只在 `logLevel: "debug"` 时写入：

```json
{
  "logLevel": "debug"
}
```

日志路径：

```text
<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log
```

### 日志验证结果（2026-11-06）

基于 2026-11-05 / 2026-11-06 的真实使用记录（`logLevel: "debug"`）验证。11-05 有 4 个 QQ 触发的 run（约 8 / 21 / 29 / 23 分钟），共 529 个启动帧（483 个工具行 + 46 个 skill 块）。

**启动帧确实发出，且带完整参数：**

- 94.2 秒的 docker build：
  - 11:49:38.449 `tool start`，`args` 包含完整 `command`；
  - 11:49:39.032 发出 `POST .../stream_messages`，`content_raw` 以 `## 💻 bash` 开头，命令放在 `bash` fenced code block 中，完整内容为 `cd .../xuanji-mock && docker compose ... build 2>&1 | tail -6`；
  - 11:49:39.643 收到 200 OK；
  - 工具在 11:51:12.689 才结束，结果帧在 11:51:12.690 发出、11:51:13.323 收到 200。
- 529 个启动帧全部能在 `stream_messages` 请求体中找到：
  `93 bash + 194 write + 150 read + 28 codemode + 18 edit + 46 skill = 529`。
- 最长的 bash 命令为 1108 字符；`content_raw` 为完整的 1134 字符（标题 + fence + 命令），没有被截断。
- `append start` 的 `waitedMs` 最大 1ms；`append done` 的 `totalMs` 中位数约 1.3s、最大 2.1s。延迟来自关旧气泡、开新流和网络往返，不是队列积压。
- 94s 工具的启动帧不是被 500ms 节流拖住的：日志为 `append: immediate`，`flush` 在 `stream open` 后立即开始。
- QQ run 期间 `event-loop` 的 `maxMs` 最大 258ms，`driftMs` 最大 82ms；没有数秒级阻塞。

**结论：** 在这些日志覆盖的场景中，TODO 1 中列出的四种可能——启动帧没发出、`content_raw` 没命令、queue/timer 延迟、事件循环饥饿——均不成立。pi-qq 侧在工具开始后约 1.2 秒内已经把带完整命令的启动帧交给 QQ API。

### 尚未验证

- QQ 客户端如何渲染这个 fenced code block。日志只能证明请求体里有完整命令，不能证明手机 QQ 一定把代码块展开显示。
- 如果手机 QQ 仍只显示“bash 和一个点”，优先检查 QQ 对带 `bash` 语言标记的 fenced block、长代码块或新气泡的折叠/渲染，而不是继续排查 relay。

### 下一步

- 不需要给工具启动行增加 `flushAfter`；当前无队列/节流延迟证据。
- 做一次 QQ 渲染 A/B：同一命令分别用带 `bash` 语言标记的 fenced block、无语言标记的 fenced block、行内代码发送，确认是否只在某种格式下显示异常。
- 如果确认是 QQ 渲染问题，再考虑缩短命令摘要或改用普通文本/行内代码；如果确认正常，可直接关闭 TODO 1。
- 若最终需要改格式，补测试并更新 `CHANGELOG.md`，再发布版本。

## 2. 长耗时命令导致 QQ 侧无输出/失去响应

> 状态：仍未复现；等待多分钟单命令日志
> 记录日期：2026-11-04
> 分析日期：2026-11-06
> 相关版本：pi-qq 1.4.0
> 详细调研：`doc/archive/delivery.2026.11.04.md`

### 现象

QQ 侧执行一个运行数分钟到数十分钟的 `bash` 命令后，可能只有最初的工具气泡，之后：

- 命令结束没有工具结果；
- 没有最终回答；
- 长命令期间发送普通消息，直到命令结束才有反应；
- 看起来像机器人“失去响应”，但电脑上的 pi TUI 仍在运行。

### 已知事实

- pi 的 bash 工具使用异步 `spawn`，长时间运行的普通命令本身不会阻塞 Node 事件循环。
- 长工具期间 pi-qq 不订阅 `tool_execution_update`，所以没有进度帧；只有 50 秒一次的 `typing`。
- 每个思考/工具气泡都会新建一条流式回复，但 `ReplyBudget` 只统计普通文本，没有把流式气泡计入 4 次被动回复上限。
- 长静默后的结果帧如果因 `msg_id` 过期或被动次数超限失败，`BubbleWriter` 会沿用同一个过期 `msg_id` / `stream_msg_id` resume，最终 `killStream()`；之后 `onToolStart()` / `onToolEnd()` 直接早退，后续工具输出丢失。
- 运行中收到的普通消息以 `steer` 进入当前 run，要等当前工具批次结束才处理。
- `/stop` 目前要等 `waitForEnd()` 才回复；如果工具不响应 abort 或流式请求在重试，会占住 SDK 的并发锁。

### 临时恢复手段

QQ 侧的 `/last` 已可用于手动恢复：

- **run 运行中**：`/last` 调用 `RunFeedback.repushCurrent()`，把当前输出重推到新消息的 `msg_id` 上，并让后续 delta 继续写入新气泡；
- **run 已结束**：`/last` 用流式重新推送最近一次完成的 assistant 文本。

因此本次不实现行为修复；`/last` 作为用户可用的手动恢复路径。

### 本次决策

- 暂不实施 v4 归档中的错误分类、预算、心跳、自动重绑等行为修改。
- 只追加可验证的 debug 日志，等待长期使用日志后再决定修复范围。
- 2026-11-06 首轮日志未复现失败路径，继续维持“只加日志、不改行为”的决定；详见“日志验证结果”。
- 新增诊断日志在 `logLevel: "debug"` 时写入；`stream error` / `stream unavailable` 原本就是 `warn`，保留为错误记录，不改变行为。

### 已追加的诊断日志

- `scope: "tool"`：
  - `start` / `end` 增加 `parentToolCallId`、`durationMs`；
  - `end` 增加 `updateCount`、`updateSpanMs`、`firstPartial`；
  - `update` 记录首次部分输出，之后每 50 次记录一次进度。
- `scope: "run"`：
  - `run started`：`phase: "no qq target"`、`source: pending/recovery`、`targetAgeMs`；
  - `tool start` / `tool end`：`phase: queued / output started / result recorded / output finished / ignored: stream dead / ignored: no active run`；
  - `stream takeover decision`：`textLength`、`deltaLength`、`hadPendingTools`、`flushOk`、`hasPushed`、`streamTookOver`、`deferredTextLen`；
  - `run ended`：`hasPendingTools`、`hasPushed`、`lastCompletedTextLength`；
  - `stream timing`：`phase: last repush / last repush ignored`；
  - 工具、最终消息和 cleanup 相关日志都带 `diagnostics`：`activeTool`、`tools`、`deferredTextLen`、`writer stats`、`budget`。
- `scope: "stream"`：
  - `stream timing` 的 `stats` 包含 `dead`、`hasStream`、`hasPendingResume`、`resumeAttempts`、`bubbleChars`、`hasPushed`、`lastKind`、`toolOpen`、`lastFrameAgeMs`；
  - `stream open` 记录是否 resume、checkpoint 的 `index` / `hasStreamMsgId` / `bufferLength`、`budget`；
  - `stream error` 增加 `phase: "frame failed"`，记录 `httpStatus`、`bizCode`、`path`、`msgSeq`、`streamMsgId`、`bufferLength`；
  - `stream unavailable` 记录 writer `stats` 和 `budget`；
  - `sendStreamReply()`（idle `/last`）记录 `phase: "last reply stream"`、`msgId`、`textLength`。
- `AppendStream` 的 `flush start/done` 增加 `msgSeq` 和 `streamMsgId`（存在时）。
- `scope: "inbound"`：`/stop` 记录 `wait start` / `wait done` 及 `waitedMs`。
- `scope: "event-loop"`：增加 `driftMs`，用于发现 timer 被事件循环延迟。

### 日志验证结果（2026-11-06）

基于 2026-11-05 / 2026-11-06 的真实使用记录验证。

**没有复现失败：**

- 最长的单条命令是 94.2 秒的 docker build；其余 e2e jest 命令为 4.2–6.8 秒。日志中没有“数分钟到数十分钟”的单条 bash。
- 94s 工具期间从启动帧到结果帧有 93.7 秒没有新流式帧，说明长工具确实没有进度帧；但结果帧在工具结束后 0.6 秒发出并收到 200，没有丢失。
- `stream error` / `stream unavailable` / `phase: "frame failed"`：0 条。
- TODO 点名的错误码 `304103`、`40034005`、`40034128`、`40034024`、`429`、`50002`：0 次。
- 529 个工具全部有 `queued → output started → result recorded → output finished`，没有 `ignored: stream dead`。
- 4 个 run 结束时均为 `dead=false`、`hasPendingResume=false`、`resumeAttempts=0`、`hasPendingTools=false`、`hadError=false`；2055 组 `AppendStream` 的 `flush start/done` 一一对应。
- 2026-11-05 有 4 个 QQ run：约 8 / 21 / 29 / 23 分钟；29 分钟的 run 结束时 `streamBubbles=184`、`streamBubblesTotal=502`，但 `budget.remaining=4`。这验证了“流式气泡没有计入 4 次被动回复上限”这个前提，但没有观察到因此失败；同一 `msg_id` 在数十分钟内仍能继续发流式帧。
- `/last` 有 3 次有效调用，全部在 run 已结束后：分别重发 1410、2320、1827 字符，均收到 200 + done。没有 `last repush`（运行中恢复）记录。日志中没有运行中收到的普通消息，也没有 `/stop`，所以 steer 阻塞和非阻塞 `/stop` 仍未验证。
- 2026-11-06 的 `event-loop maxMs=41,266,045.8` 样本与机器休眠/恢复一致，不是事件循环被阻塞 11 小时：它出现在 23:32:06.970，与 WebSocket 1006 关闭/重连同一时刻，下一次采样已回到 259ms。

**结论：** 这些日志不能验证“长命令后 QQ 无输出/失去响应”的失败路径，也不能据此实施错误分类、预算或自动重绑修复。它们只支持两个前提：长工具期间没有进度帧；流式气泡没有计入被动回复预算。真正的触发条件仍需一次单条命令运行数分钟（最好 >5 分钟，甚至 >1 小时）的日志。

### 复现时仍需采集/分析

本次日志没有出现这些错误，以下步骤保留给下次复现时使用。

1. 找到长命令的 `scope: "tool"` `start` / `end`：
   - `durationMs` 是否与用户感知一致；
   - `updateCount` 是否为 0，判断长命令期间是否完全没有部分输出。
2. 看 `scope: "stream"` 的 `stream timing`：
   - `tool queued` 时间；
   - `append start` 的 `waitedMs` / `lastFrameAgeMs`；
   - `append done` 的 `totalMs`；
   - 工具结束到结果帧之间隔了多久。
3. 看 `stream error` 的 `phase: "frame failed"`：
   - `httpStatus` / `bizCode` 是否为 `304103`、`40034005`、`40034128`、`40034024`、`429`、`50002`；
   - `streamMsgId` 是否存在，`bufferLength` 是否持续增长。
4. 看 `stream unavailable` 之后 `scope: "run"` 的：
   - `tool start/end` 是否出现 `ignored: stream dead`；
   - `stream takeover decision` 的 `flushOk` / `hasPushed` / `hadPendingTools`；
   - `run ended` 的 `hasPendingTools`。
5. 如果用户使用了 `/last`，看 `phase: "last repush"` 或 `"last repush ignored"`，确认是否恢复、恢复后是否仍有输出。
6. 看 `scope: "event-loop"` 的 `maxMs` / `p99Ms` / `driftMs`：
   - 如果达到数秒甚至更高，优先排查 CPU 饥饿；
   - 如果正常，则更可能是 QQ 被动窗口/配额或 relay 状态问题。
7. 对照 `/qq-test-budget` 的 `remaining`、`streamBubbles`、`streamBubblesTotal`，确认是否早已超过 4 次。

### 需要提供的信息

本次日志没有覆盖多分钟单命令、运行中收到的普通消息、`/stop` 和 `/qq-test-budget` 输出；复现时请按以下清单提供：

- `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`；
- 长命令内容、开始时间和结束时间；
- QQ 上最后一条可见消息及时间；
- 期间是否发送过 `/status`、`/stop`、普通文本、`/last`；
- `/qq-test-budget` 和 `/qq-status` 输出；
- 手机 QQ 是否在前台，是否允许主动消息。

### 下一步

- 本次日志未复现失败；不要据此实施错误分类、预算或自动重绑修复。
- 继续等待一次真正的多分钟单命令日志（最好 >5 分钟，并覆盖 >1 小时的 `msg_id` 生命周期）；复现时按上面的“复现时仍需采集/分析”执行。
- 如果目标只是改善长工具期间的体感：优先实现长工具心跳和 `tool_execution_update` 转发，这不依赖失败复现。
- 如果后续日志确认 `msg_id` 过期/被动次数超限：再按 `doc/archive/delivery.2026.11.04.md` 的“Long-running tools”建议实现错误分类和预算修复。
- 如果 `/stop` 的 `wait done` 缺失或 `waitedMs` 很大：实现非阻塞 `/stop`。
- `/last` 目前作为手动兜底可用，保持现状，不急于自动重绑。
- 修复后补测试，更新 `doc/todo.md` / `CHANGELOG.md`，再发布版本。
