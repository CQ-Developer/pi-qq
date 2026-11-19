# TODO

> 只记录未完成项目；已完成项目直接删除，不使用勾选状态。
> 1.7.1 交付记录与验证：`doc/archive/delivery.1.7.1.md`

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
  - 每 5 秒记录一次 `meanMs`、`maxMs`、`p99Ms`、`driftMs`、`utilizationPercent`。

2026-11-19 起，逐帧 `append` / `timer` / `flush: start` 日志已删除，只保留慢帧（≥1s）和分片未发完（`remaining>0`）的 `flush:` 摘要；聚合 `streamTiming` 保留。

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
- 2026-11-18 main 构建：`tool start` 后 1.1–3.2s（中位数约 1.4s）工具行才发出；`waitedMs` 多为 0，延迟来自旧气泡 DONE + 新流 RTT，不是队列积压。仍需确认 QQ 客户端是否把长命令折叠成“bash 和一个点”。

### 下一步

- 不需要给工具启动行增加 `flushAfter`；当前无队列/节流延迟证据。
- 做一次 QQ 渲染 A/B：同一命令分别用带 `bash` 语言标记的 fenced block、无语言标记的 fenced block、行内代码发送，确认是否只在某种格式下显示异常。
- 如果确认是 QQ 渲染问题，再考虑缩短命令摘要或改用普通文本/行内代码；如果确认正常，可直接关闭 TODO 1。
- 若最终需要改格式，补测试并更新 `CHANGELOG.md`，再发布版本。

## 2. 流式消息生命周期的长期观察

> 状态：持续观察；仅保留尚未验证的长期风险

### 背景

2026-11-12 的真实 QQ 实验确认：

- 流的总生命周期约 600 秒，边界有约 1 秒抖动；
- 心跳不能延长生命周期；
- 过期后同 `msg_id` 新流、`is_wakeup=true`、新入站目标都能恢复；
- 12 分钟真实 agent 工具已验证自动新开流。

### 进度

- 20 分钟同 `msg_id` 新流：已验证（`expire 20`，1203.5s）；
- 2026-11-19 真实使用：17 个 run、438 个气泡，寿命 max 208s，0 次 `40034020`；高频轮换掩盖了 600s 边界；
- 超过 20 分钟的同 `msg_id` 新流：未验证；
- 1 小时以上 `msg_id`：未验证。

### 需要观察

- 平台生命周期是否随账号、地区、客户端版本变化；
- 真实网络抖动、重连、限流下的表现；
- 超过 20 分钟的同 `msg_id` 新流是否仍可用；
- 真实使用中 `40034020` 的恢复是否仍能稳定送达结果；
- 受控测试：单个长静默工具持续约 11 分钟（不产生中间输出），验证 600s 边界、自动新开流和 DONE（2026-11-19 决定）。

实验记录见 `doc/archive/delivery.1.7.1.md`。

## 3. 调试日志的发布后复核

> 状态：待下一次真实使用日志复核
> 记录日期：2026-11-19

- typing 真实网络超时：1.7.1 已在流活跃时跳过 typing，但 10s 超时尚未在真实网络复现。
- 日志改动已实施：`tools` 只保留最近 3 个已完成 + 活动工具（不含参数/结果）、逐帧 append/flush/timer 日志删除、`run ended` 合并到最终 DONE 之后、短 ID 统一、`bubble split` 记录原因与大小、event-loop 使用 1ms 分辨率和 ELU。
- 待确认：下一次真实日志的体积、短 ID 是否便于关联、慢帧/分片摘要是否足够定位协议问题。
- 短 ID 规则：`messageId` / `msgId` / `streamMsgId` 取 `sha256` 前 8 位十六进制；`senderId` / `appId` 保留完整。QQ 消息 ID 的头尾均固定，贴边切片会碰撞。
