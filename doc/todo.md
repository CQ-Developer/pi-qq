# TODO

> 2026-11-12 更新：长耗时命令条目已完成修复并移除，详见 `doc/stream-test-report.md`。TODO 1 的启动帧和参数传递已确认正常，仍待确认 QQ 客户端渲染。

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

## 2. 2026-11-12 测试报告后的剩余验证

> 状态：待验证
> 测试报告：`doc/stream-test-report.md`
> 说明：原 TODO 2（长耗时命令）已修复并移除；以下只保留尚未覆盖的场景。

### P1：`/stop` 非阻塞

测试已确认：不响应 abort 的长工具会让 `/stop` 等到工具结束（约 2m57s）；可 abort 工具约 1s 结束。

- [ ] 修改 `handleInboundCommand` 的 `/stop`：`ctx.abort()` 后立即回复，不等待 `waitForEnd()`。
- [ ] `waitForEnd()` 只做后台日志或后续通知，不能阻塞 `/stop` 回复。
- [ ] 补测试：`waitForEnd` 永不 resolve 时，`/stop` 仍立即回复。
- [ ] 用真实 agent 重跑 `LONG_TOOL_TEST` + `/stop`，确认回复不再等 3 分钟。

### P2：真实 agent 长工具端到端

- [ ] 让真实 agent 执行 12 分钟以上工具，确认 `40034020` 后自动新开流、工具结果和最终回答都送达。
- [ ] 当前 `relay 10.5` 已覆盖相同 `RunFeedback` / `BubbleWriter` 路径，但还没有真实 prompt/工具链。

### P2：无换行超大单行

- [ ] 通过真实 QQ 发送 >3.5KB、内部没有换行的内容，验证 `AppendStream` 硬切补 `\n` 后不出现 `40034017`。
- [ ] 当前只做了单测；带换行的 5.5KB 大帧已真实通过。

### P3：20 分钟以上同 `msg_id`

- [ ] 可选：`EXP: expire 20`，确认 20 分钟以上仍能用同一 `msg_id` 开新流。
- [ ] 原日志已有入站 22 分钟后创建新流的证据，因此优先级低于 P1/P2。

### P3：被动回复预算

- [ ] 验证超过 6 条普通文本、或跨更长时间窗口时的平台行为。
- [ ] 对比本地 `ReplyBudget` 的 4 次限制与平台实际限制；在确认前不要移除本地限制。
- [ ] 当前 `EXP: budget 6` 通过，但实验绕过了本地 `ReplyBudget`。

### P3：`/stop` 日志

- [ ] 调整 log gate，使 `/stop wait done` 和 `/stop` 回复在 run 结束后仍能落盘。
- [ ] 当前 run 结束后 gate 关闭，导致无法从日志确认 `/stop` 的实际回复时间。
