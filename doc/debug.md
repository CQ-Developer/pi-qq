# 流式消息超时与 watchdog 调研

> 状态：调研完成；P1 已实现；watchdog 方案待真实实验确认
> 日期：2026-11-11
> 范围：pi-qq 1.7.0，QQ C2C `stream_messages`
> 相关：`doc/todo.md` §2

## 1. 现象与日志证据

日志：`~/project/mine/pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-11.log`（18 MB / 18,406 行，时间戳为 UTC）。

### 1.1 `40034020`：长工具期间无帧

- 12:25:13.188：`seq=237` 首帧 442 字符，工具头为 `docker compose ... up -d --build`，随后开始 23m28s 的构建。
- 12:48:40.426：下一次发帧，返回：
  `{"code":40034020,"err_code":40034020,"message":"同一流式消息发送超过时间限制"}`
- 12:48:46 / 12:48:47：用同一个 `stream_msg_id` 再 resume 两次，仍返回 400。
- 12:48:47.386：`stream unavailable`，writer dead；之后工具结果只进入本地 timeline，不进入 QQ。
- 12:59:17：用户 `/last` 换新 `msgId` 重推快照，流恢复。
- 死流窗口内完成 36 个工具；`/last` 快照只重放最近 3 个已完成工具，33 个结果未显示。

### 1.2 `40034017`：单帧过大

- 13:21:36.489：成功帧 3706 字符 / 3743 B。
- 13:23:37.501：`seq=30` 首帧 4672 字符 / 4719 B，返回：
  `{"code":40034017,"err_code":40034017,"message":"流式消息md分片需要\\n结束"}`
- 13:24:05 / 13:24:12：resume 后 buffer 继续增长到 5044 / 5145 B、5062 / 5170 B，仍返回 40034017。
- 13:24:13：`stream unavailable`；死流窗口内 9 个 read 工具，3 个被 `/last` 重放，6 个未显示。
- 13:25:37：用户 `/last` 恢复；13:28:48 run 正常结束。

### 1.3 真实实验（2026-11-12）

| 实验                  | 结果                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `EXP: idle 2`         | 首帧后空闲 120.0s，探针成功                                                    |
| `EXP: idle 5`         | 首帧后空闲 300.0s，探针成功                                                    |
| `EXP: idle 10`        | 首帧后空闲 600.0s，探针返回 `40034020`                                         |
| `EXP: heartbeat 10 1` | 每分钟心跳，前 9 次成功，第 10 次在流创建后约 600.0s 返回 `40034020`           |
| `EXP: rotate 5`       | 5 分钟后主动关闭旧流，同 `msg_id` 新流成功；新 `msg_seq=2`、新 `stream_msg_id` |
| `EXP: rotate 8`       | 8 分钟后主动关闭旧流，同 `msg_id` 新流成功；距 600s 上限约 2 分钟              |

结论：强证据指向**流的总生命周期约 600 秒**，而不是单纯空闲超时；每分钟心跳不能续命。还需用 `rotate` / `expire` 实验确认“提前轮换”和“过期后新流”的行为。当前不应再按“5 分钟心跳”设计 watchdog。

### 1.4 结果完整性

- run 结束时的 `currentTextLen` 分别为 2202 / 1831，与流式帧重建文本一致，最终回答没有丢失。
- 事件循环最大延迟 618 ms，没有秒级阻塞，不是本次故障原因。
- 本日志没有 `40054005`；错误文本用 `msg_seq=2`，下一条流从 `msg_seq=3` 开始，说明 1.7.0 的 per-message `msg_seq` 分配生效。

## 2. 官方文档核对（2026-11-11）

核对的页面：

- `https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html`
- `https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html`

结论：

- 流式接口页只列出接口频率限制 **50 QPS**，错误码只有 `40007`、`50001`、`50002`。
- 流式接口页没有 `40034020`、`40034017`、`40034128`、`304103`，也没有“30 分钟”“128 KB”“心跳”“定期关闭流”等说明。
- 错误码页只列出 HTTP 状态码和公共错误码；其中 `40034005` 是“回复消息 msg_id 已过期”，没有 `40034020`。
- 流式接口页明确 `input_mode=append`（默认）和 `replace` 的差异；`stream_msg_id` 首条由服务端返回，后续分片携带。
- 流式接口页说明 `is_wakeup`：“是否为召回消息。true 时不校验 msg_id/event_id 有效期”。这是目前唯一与“过期后继续发送”相关的官方线索，但它是召回消息语义，不能直接当作普通长任务的续流方案。

## 3. 外部搜索结论

外部搜索材料 `a.md`、`b.md` 已读并删除。

- `a.md` 的结论可靠：官方没有定义 `40034020`，没有官方 30 分钟或心跳建议；需要实验确认。
- `b.md` 的“总传输时长 30 分钟”不能采信：官方页面没有这句话；它引用了其他平台（环信）的文档；而且现场流在 23m28s 就失败，与“30 分钟总时长”矛盾。
- 未找到官方 SDK 或主流开源项目专门处理 `40034020` 的代码。
- 不要引用 `b.md` 的 30 分钟、128 KB 等数字作为 QQ 平台限制。

## 4. 假设

| 编号 | 假设                                     | 支持证据                                                | 反证/不确定性                                                   |
| ---- | ---------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| H1   | 平台对同一条流有“空闲超时”               | 心跳前 9 次成功，说明帧能到达                           | 每分钟心跳仍在约 600s 失败，说明不是简单空闲超时；H1 基本被推翻 |
| H2   | 平台对同一条流有“总生命周期上限”         | `idle 10` 和 `heartbeat 10/1` 都在约 600.0s 失败        | 仍需 `rotate` 确认提前关闭后新流是否可用                        |
| H3   | 长时间无帧后服务端清理了 `stream_msg_id` | 用同一个 `stream_msg_id` resume 连续失败                | 错误码仍指向时间限制，不是“流不存在”                            |
| H4   | `msg_id` 本身也会过期，和流超时独立      | 官方默认校验 `msg_id/event_id`；`is_wakeup=true` 可跳过 | 本次流在入站 22 分钟后仍能创建，5 分钟规则未必严格适用于 stream |
| H5   | `40034017` 是单帧超过平台分片上限        | 成功最大 3706 字符/3743 B，失败从 4672 字符/4719 B 开始 | 官方未给出字节/字符上限；3500 B 是推断值                        |

## 5. 当前 P1 实现

### 5.1 帧切分

`src/relay/stream-session.ts`：

- `MAX_FRAME_BYTES = 3500`；
- `takeFrame()` 按 UTF-8 字节切帧，优先在最后一个 `\n` 处切；
- 无换行的超长单行硬切并补 `\n`；
- `flush()` / `done()` 循环发完所有分片，分片间保留 300 ms 节流；
- 同时覆盖正常运行流和 idle `/last` 的 `sendStreamReply()`。

解决问题：`40034017` 的超大首帧。

### 5.2 `40034020` 新开流

`src/relay/bubble-writer.ts`：

- `40034020` 与 `40054005` 一样视为不可 resume；
- 新开流：新 `msg_seq`、`index=0`、不带旧 `stream_msg_id`、保留未确认 buffer；
- 暴露 `deadCode`，`stream unavailable` 日志记录错误码。

解决问题：不再用已过期的 `stream_msg_id` 做无意义 resume。

### 5.3 自动重绑

`src/relay/run-stream-relay.ts`：

- 流因 `40034020` 熔断后，在下一次 assistant final 自动重绑；
- 优先使用 5 分钟内的 `budget.lastTarget`，否则使用当前目标；
- 重放快照（当前 thinking + 最近最多 5 个工具 + 当前文本）；
- 每个 run 最多自动重绑 1 次。

解决问题：有新鲜入站消息时，不需要用户手动 `/last`。

### 5.4 仍未解决

- 首个失败帧仍可能发生；auto-rebind 要到下一次 assistant final 才执行。
- 没有新鲜入站消息时，旧 `msg_id` 可能已过期；新流仍可能失败。
- 没有 watchdog，长工具期间仍然没有进度帧。
- `autoRebinds` 每次 run 只有 1 次；如果第一次目标无效，不会自动再试。

### 5.5 优先级清单（P1–P3）

| 优先级 | 问题                                   | 改动                                                    | 状态                                      | 位置/证据                                              |
| ------ | -------------------------------------- | ------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| P1     | `40034017` 超大帧                      | 单帧 ≤3500 B，优先换行切分，硬切补 `\n`                 | 已完成                                    | `src/relay/stream-session.ts`；新增分片测试            |
| P1     | `40034020` 用旧 `stream_msg_id` resume | 新 `msg_seq`、`index=0`、不带旧 `stream_msg_id`         | 已完成                                    | `src/relay/bubble-writer.ts`                           |
| P1     | 死流后无自动恢复                       | auto-rebind 最近 5 分钟入站，重放快照，每 run 最多 1 次 | 已完成                                    | `src/relay/run-stream-relay.ts`                        |
| P1     | 长工具期间无帧                         | 空闲心跳/轮换 watchdog                                  | 待实验                                    | 本文 §6、§7                                            |
| P2     | 死流时 QQ 侧静默                       | 死流提示，或自动 repush 当前快照                        | 部分完成（auto-rebind 已有；QQ 提示未做） | `onWarn` 目前只走 TUI；`src/relay/run-stream-relay.ts` |
| P2     | typing 超时可能阻塞流帧                | 隔离 typing，避免串行发送被拖住                         | 未做                                      | 日志 13:17:24–13:17:55；两次 10s 连接超时              |
| P3     | run 触发消息未入日志                   | 在 log gate 打开前记录，或缓冲到 run 开始               | 未做                                      | `index.ts:101`、`src/infra/file-logger.ts`             |
| P3     | 日志含敏感信息                         | 对命令/结果中的密码、token、session 做脱敏              | 未做                                      | 日志含本地 DB 凭据、临时账号密码、Redis 会话键         |
| P3     | `append: while flushing` 噪声          | 降频/聚合日志                                           | 未做                                      | 4,945 行，约占 18 MB 日志的 27%                        |
| P3     | 文档与发布记录                         | 更新 `CHANGELOG.md` / `doc/todo.md`                     | 部分完成（P1 已写；P2/P3 未写）           | `CHANGELOG.md`、`doc/todo.md` §2                       |

## 6. watchdog 方案

watchdog 的目标：在平台返回 `40034020` 之前，主动处理长时间无帧或超长生命周期的流。

### 6.1 监控量

- `idleMs = now - lastFrameAt`：距离上一次成功发帧多久；`lastFrameAt` 已在 `BubbleWriter` 中维护。
- `ageMs = now - streamOpenedAt`：当前流从打开到现在多久；需要新增 `streamOpenedAt`。
- `toolOpen`：当前是否在工具块内，用于决定是否保留工具上下文。

### 6.2 可选动作

| 方案          | 触发                  | 动作                                                | 优点                                   | 缺点                                          |
| ------------- | --------------------- | --------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| A 空闲心跳    | `idleMs > N`          | 发一帧 `"\n"` 或“⏳ 仍在运行…”，重置计时            | 不切碎气泡；若限制是空闲超时则直接有效 | 若限制是总生命周期则无效；会增加空行/进度文字 |
| B 空闲轮换    | `idleMs > N`          | 关围栏、`flush`、`done`、`cur=null`；下次输出开新流 | 不增加内容；避免旧流继续挂起           | 工具结果会落到新气泡，可能缺少工具头          |
| C 总寿命轮换  | `ageMs > M`           | 同 B                                                | 对总生命周期限制有效                   | 阈值未知；长工具会产生多个气泡                |
| D 混合        | 空闲心跳 + 总寿命轮换 | A + C                                               | 覆盖两类限制                           | 实现和配置最复杂                              |
| E 可配置/关闭 | 默认关闭，配置开启    | 按 A/B/C 选择                                       | 不在未知阈值上做默认行为               | 需要用户配置，默认不改善体感                  |

### 6.3 5 分钟能解决吗

实际实验结果（2026-11-12）：流的总生命周期约 **600 秒**，每分钟心跳不能续命。

- **5 分钟心跳不够**：心跳只能证明 5 分钟内还活着，流仍会在约 600s 过期。
- **5 / 8 分钟轮换已验证可行**：在 600s 前关闭旧流并开新流，可以重置生命周期；新流仍需要有效的 `msg_id`。
- **工具超过 10 分钟且没有新入站**：即使 watchdog 在 5 分钟关闭旧流，10 分钟后结果到达时原 `msg_id` 可能已过期；新流仍可能失败。
- 本次日志有 20:47:53 的 `/status`，所以“8 分钟轮换 + auto-rebind”在这个场景可能恢复；但这是有新鲜入站的特例，不是通用保证。

因此 watchdog 的主方案应从“心跳”改为“在 600s 前轮换”；`rotate 5` / `rotate 8` 均成功，暂定阈值 **8 分钟**。

### 6.4 实现注意点

- 定时器必须走 `BubbleWriter` 现有的 `queue`，避免和 `append` / `rotateStream` 并发。
- 定时器在 `rotateStream`、`resetForRestart`、`dispose` 时清理；`unref()` 避免阻止进程退出。
- 每次成功 append 重置 idle 计时；`streamOpenedAt` 不重置。
- 心跳帧内容需要实测：`content_raw=""` 是否允许未知；`"\n"` 至少满足分片换行要求，但会留下空行。
- 如果采用轮换，工具结果会进入新气泡；建议在结果前补一行 `## 💻 <tool>（继续）`，或接受无头结果气泡。

## 7. 实验计划

目标：区分“空闲超时”和“总生命周期”，并确认过期后的新流策略。使用测试账号和测试用户，避免影响真实会话。

### 7.1 实验 A：心跳是否有效

- 用一条新鲜入站消息开流；
- 首帧成功后，每 1 分钟发一个极小心跳帧（`content_raw="\n"`，`input_state=1`，`index` 递增，`msg_seq` 与 `stream_msg_id` 不变）；
- 持续 30 分钟，然后发正常内容帧和 `input_state=10`；
- 记录首个非 200 的时间、错误码、是否还能结束。

### 7.2 实验 B：无心跳对照

- 同样的新鲜入站消息开流；
- 首帧后完全不发帧；
- 在 2 / 5 / 10 / 15 / 20 分钟分别用**独立的新流**探测（避免探测帧重置同一个流的空闲计时）；
- 记录每个时间点首次发帧是否成功。

### 7.3 实验 C：过期后新流

- 触发 `40034020` 后，用同一个入站 `msg_id`、新 `msg_seq`、`index=0`、不带旧 `stream_msg_id` 开新流；
- 若失败，再试 `is_wakeup=true`；
- 若仍失败，用一条全新的入站消息；
- 记录三种情况的首帧结果和错误码。

### 7.4 实验 D：主动轮换

- 开流后 5 分钟主动 `done` 关闭；
- 用同一条入站消息开新流，发送一条普通文本；
- 观察新流是否被接受；
- 再模拟 23 分钟长工具：关闭后等待，结果到达时开新流并发送结果。

### 7.5 记录字段

每次实验记录：

- 开流时间、`msg_id` 年龄、`event_id`、`msg_seq`、`stream_msg_id`；
- 每次帧的时间、`index`、`content_raw` 长度、HTTP 状态、错误码；
- 首次 `40034020` 时间；
- 新流是否成功、是否用了 `is_wakeup`；
- QQ 侧实际显示（气泡数量、空行、工具头是否缺失）。

## 8. 计划与待决策

### 8.1 建议顺序

1. 保留已实现的 P1，不先写死 watchdog 阈值。
2. 用第 7 节实验确认 H1/H2/H4。
3. 根据结果选择：
   - 空闲超时 → 空闲心跳（方案 A）；
   - 总生命周期 → 总寿命轮换（方案 C）；
   - 两者都有 → 混合（方案 D）；
   - 目标 `msg_id` 过期是主要问题 → 优先 auto-rebind / `is_wakeup` / 主动消息。
4. 补测试、更新 `CHANGELOG.md` / `doc/todo.md`，再发布。

### 8.2 如果必须现在上线 watchdog

2026-11-12 实验结果推翻了“5 分钟心跳”方案：

- 流总生命周期约 **600 秒**，心跳不能续命；
- 主方案改为 **在 600s 前主动轮换**；`rotate 5` / `rotate 8` 均成功，暂定阈值 **8 分钟**；
- 轮换后需要新流；如果原 `msg_id` 已过期，仍需 auto-rebind 到新鲜入站；
- 保留 `40034020` 新开 + auto-rebind；
- 配置项允许关闭或调整 `streamRotateAfterMs`；
- 明确文档：这是缓解，不保证 `msg_id` 过期后的投递。

不推荐只做心跳：本次实验已经证明心跳无法突破约 600s 的总生命周期。

### 8.3 待决策

1. watchdog 默认开启还是默认关闭？
2. 默认只做空闲心跳，还是同时做总寿命轮换？
3. 心跳内容用 `"\n"` 还是“⏳ 工具仍在运行…”？后者更可读，但会增加内容。
4. 轮换后是否重发工具头？重发会增加重复信息，不重发会出现无头结果气泡。
5. `autoRebinds` 是否从 1 次提高到 2 次？需要防止反复失败刷屏。
6. 是否测试 `is_wakeup=true` 作为长任务续流方案？它可能只适用于召回消息，不能直接用于普通回复。
7. 3500 B 是否需要按真实 API 再校准？当前是日志推断值。

## 9. 实验环境（2026-11-11）

已在 `~/project/mine/pi-qq-test` 准备好真实 QQ 实验环境：

- `run-experiment.sh`：启动本地 pi-qq（`-ne -e ../pi-qq`）和实验扩展，并设置 `PI_QQ_EXPERIMENTS=1`、独立的 `PI_QQ_LOG_DIR`。
- `.pi/extensions/stream-exp.ts`：拦截 QQ 的 `EXP:` 消息，直接调用 `AppendStream` / `messageApi`，不经过模型。
- `README-experiment.md`：启动步骤、命令、建议顺序和日志位置。

QQ 命令：

```text
EXP: help
EXP: idle <minutes>
EXP: heartbeat <minutes> [intervalMinutes]
EXP: expire <minutes>
EXP: rotate <minutes>
EXP: status
EXP: stop
EXP: ping
```

日志：

- `.pi/pi-qq/experiments/exp-YYYY-MM-DD.jsonl`：帧级实验日志。
- `.pi/pi-qq/experiment-logs/pi-qq-YYYY-MM-DD.log`：pi-qq 自身日志，与旧日志隔离。

本地钩子：pi-qq 在 `PI_QQ_EXPERIMENTS=1` 时暴露 `__piQQExperimentDebug`（running bot、last target、cancelPending），仅用于实验；不设置该环境变量时不暴露。

## 10. 参考

- 日志：`~/project/mine/pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-11.log`
- 官方流式接口：`https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html`
- 官方错误码：`https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html`
- 代码：`src/relay/stream-session.ts`、`src/relay/bubble-writer.ts`、`src/relay/run-stream-relay.ts`
- 测试：`test/relay/stream-session.test.ts`、`test/relay/bubble-writer.test.ts`、`test/relay/run-stream-relay.test.ts`
