# TODO

## 1. 长运行 bash 工具的参数延迟显示

> 状态：TODO，等待长期使用日志  
> 记录日期：2026-11-04  
> 相关版本：pi-qq 1.3.6（仅增加 debug 日志）

### 现象

正常使用中，bash 执行 e2e 测试通常需要数分钟。此时 QQ 上只能看到 `bash` 和一个点，看不到命令参数；理论上工具名称和参数应该在 `tool_execution_start` 后立即出现，只有结果需要等待工具结束。

### 已知事实

- `AppendStream` 默认有 500ms 节流；这是 pi-qq 自己设置的值，不是 QQ 限制。
- 500ms 定时器不依赖工具 Promise；长工具的启动帧曾在工具结束前通过 `stream_messages` 发出。
- pi 内置 bash 使用异步 `spawn`，正常情况下不会阻塞 Node 事件循环。
- 本地异步子进程可持续触发 500ms timer，说明“bash 子进程本身”不是必然的事件循环阻塞源。
- 当前还没有这次 e2e 的长期使用日志，无法判断：
  - 启动帧是否真的发出；
  - `content_raw` 是否包含命令；
  - timer/队列/事件循环是否被延迟；
  - QQ 是否把长行内代码折叠成了一个点。

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

### 下次日志分析步骤

1. 找到 e2e 的 `toolStart`：
   - `scope: "tool"`
   - `toolName: "bash"`
   - `args` 是否包含完整 `command`。
2. 找到随后 `scope: "stream"` 的时序日志：
   - `tool queued` 时间；
   - `append start` 的 `waitedMs`；
   - `append done` 的 `totalMs`；
   - `append: buffered` / `timer: fired` / `flush: start` 时间。
3. 找到对应的 `POST .../stream_messages`：
   - 请求时间；
   - `content_raw` 是否包含命令参数。
4. 对照 `scope: "event-loop"` 的 `maxMs` / `p99Ms`：
   - 如果事件循环延迟达到数秒/数分钟，说明 Node 主线程被饿死；
   - 如果 event-loop 正常，但 `append start` 的 `waitedMs` 很大，说明前面的流/队列阻塞；
   - 如果 POST 很快且 `content_raw` 有命令，但 QQ 只显示一个点，说明是 QQ 渲染/截断。

### 下一步

- 收集长期使用日志后，确定是事件循环、队列、网络还是 QQ 渲染问题。
- 如果是队列/缓冲问题，考虑给工具启动行增加 `flushAfter`。
- 长命令参数已改为 bash fenced code block；如果仍显示异常，检查 QQ 对代码块的渲染并考虑缩短命令摘要。
- 如果是 e2e CPU 导致的事件循环饥饿，需要评估 TUI/tool output 的同步开销，或把 relay 移出主进程。
- 修复后补测试，更新 `doc/todo.md` / `CHANGELOG.md`，再发布版本。

## 2. 长耗时命令导致 QQ 侧无输出/失去响应

> 状态：TODO，等待长期使用日志
> 记录日期：2026-11-04
> 相关版本：pi-qq 1.4.0
> 详细调研：`doc/archive/delivery-v4.md`

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

### 下次日志分析步骤

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

复现后请提供：

- `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`；
- 长命令内容、开始时间和结束时间；
- QQ 上最后一条可见消息及时间；
- 期间是否发送过 `/status`、`/stop`、普通文本、`/last`；
- `/qq-test-budget` 和 `/qq-status` 输出；
- 手机 QQ 是否在前台，是否允许主动消息。

### 下一步

- 如果日志确认 `msg_id` 过期/被动次数超限：按 `doc/archive/delivery-v4.md` 的“Long-running tools”建议实现错误分类和预算修复。
- 如果日志显示流一直存活但没有新帧：优先实现长工具心跳和 `tool_execution_update` 转发。
- 如果事件循环 `driftMs` / `p99Ms` 很高：排查 e2e CPU、TUI 渲染和同步工具代码。
- 如果 `/stop` 的 `wait done` 缺失或 `waitedMs` 很大：实现非阻塞 `/stop`。
- 如果 `/last` 已能稳定恢复，保持为手动兜底，不急于自动重绑。
