# QQ 流式消息超时测试报告

> 日期：2026-11-12
> 状态：完成
> 测试对象：pi-qq 1.7.0 + P1 修复（帧切分、`40034020` 新开流、auto-rebind）
> 代码基线：`7e3eb54`
> 相关文档：`doc/debug.md`

## 1. 摘要

本次测试在真实 QQ C2C 私聊上验证了 `stream_messages` 的过期行为。核心结论：

- 流的总生命周期约为 **600 秒**，不是单纯“空闲超时”；
- 每分钟心跳不能延长生命周期，第 10 次心跳仍在约 600 秒处返回 `40034020`；
- 在 600 秒前主动 DONE 并新开流，5 分钟和 8 分钟轮换都成功；
- 流过期后，用**同一个 `msg_id`**、新 `msg_seq`、`index=0`、不带旧 `stream_msg_id` 立即开新流，成功；
- 因此当前 P1 的 `40034020` 新开流逻辑应能覆盖原日志中的 23 分钟长工具场景；watchdog 不是必需项；
- `40034017` 的超大帧由 P1 的 3500 B 帧切分处理；已用真实 5.5KB 帧验证通过；无换行超大单行的硬切仍只有单测。

## 2. 测试目标

1. 确认 `40034020` 的触发条件：空闲超时还是流的总生命周期。
2. 确定实际阈值，判断 5 分钟 watchdog 是否有效。
3. 验证心跳是否能保活。
4. 验证在过期前主动轮换新流是否可行。
5. 验证过期后能否用同一个 `msg_id` 开新流。
6. 判断 P1 修复是否足以恢复原日志中的长工具场景。
7. 检查原日志中的 `40034017` 大帧问题和最终回答完整性。

## 3. 测试环境

- 操作系统：Linux
- pi：1.5.2
- Node.js：24.22.0
- 测试目录：`~/project/mine/pi-qq-test`
- pi-qq：本地 `../pi-qq`，版本 1.7.0 + P1 修复
- QQ：C2C 私聊，测试机器人 AppID `1906****`，测试用户 openid `E64787A2…`
- 实验入口：`.pi/extensions/stream-exp.ts`，拦截 QQ 的 `EXP:` 消息，直接调用 `AppendStream`，不经过模型
- 启动脚本：`run-experiment.sh`
- 独立日志目录：`PI_QQ_LOG_DIR=.pi/pi-qq/experiment-logs`

实验日志：

- `.pi/pi-qq/experiments/exp-2026-11-12.jsonl`（193 行）
- `.pi/pi-qq/experiment-logs/pi-qq-2026-11-12.log`

## 4. 测试方法

- 每个实验使用一条新的 `EXP:` 入站消息作为目标，避免复用旧目标。
- 同一时间只运行一个实验；`EXP: stop` 可中止。
- 实验扩展使用 pi-qq 的 `AppendStream` 和 `messageApi`，因此帧格式、`msg_seq`、`stream_msg_id` 行为与生产代码一致。
- `EXP: idle <n>`：首帧后不发送任何帧，等待 n 分钟，再发探针帧。
- `EXP: heartbeat <n> <interval>`：首帧后按间隔发送小帧，观察首次失败时间。
- `EXP: rotate <n>`：n 分钟后主动 DONE，关闭旧流，再用同一 `msg_id` 开新流。
- `EXP: expire <n>`：等待 n 分钟后探测旧流；失败后尝试同 `msg_id` 新流、`is_wakeup=true`、新入站目标。
- 每次实验记录：帧时间、`index`、`msg_seq`、`stream_msg_id`、HTTP 状态、错误码、DONE 结果。

判定标准：

- 成功：探针/新流首帧返回 200，DONE 成功；
- 预期失败：在约 600 秒处返回 `40034020`；
- 非预期失败：其他错误码、超时、内容丢失或无法 DONE。

## 5. 测试结果

### 5.1 结果汇总

以下时间为 UTC+8；日志 `time` 字段为 UTC。

| 用例                           | 开始     | 关键时长              | 结果                                                                    | 判定                                 |
| ------------------------------ | -------- | --------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| `EXP: help`                    | 00:13:32 | —                     | 实验链路可接收 QQ 消息                                                  | 通过                                 |
| `EXP: idle 2`                  | 00:24:51 | 空闲 120.0s           | 探针成功，DONE 成功                                                     | 通过                                 |
| `EXP: idle 5`                  | 00:28:58 | 空闲 300.0s           | 探针成功，DONE 成功                                                     | 通过                                 |
| `EXP: idle 10`                 | 00:37:14 | 空闲 600.0s           | 探针返回 `40034020`                                                     | 预期失败                             |
| `EXP: heartbeat 10 1`          | 00:49:06 | 第 10 次心跳约 600.0s | 前 9 次成功，第 10 次 `40034020`                                        | 预期失败                             |
| `EXP: rotate 5`                | 01:02:21 | 300.0s 后轮换         | 同 `msg_id` 新流成功                                                    | 通过                                 |
| `EXP: rotate 8`                | 01:08:41 | 480.0s 后轮换         | 同 `msg_id` 新流成功                                                    | 通过                                 |
| `EXP: expire 10`               | 01:19:57 | 600.0s 后过期         | 同 `msg_id` 新流立即成功                                                | 通过                                 |
| `EXP: expire-full 10`          | 02:48:20 | 10m                   | 旧流约 601s 后 40034020；同 `msg_id`、`is_wakeup`、新入站均成功         | 通过                                 |
| `EXP: large 5`                 | 01:57:58 | 2.8s                  | 5568 字符拆成 3371 + 2197 两帧，均成功                                  | 通过                                 |
| `EXP: relay 10.5`              | 02:32:54 | 10.5m                 | 旧流 40034020 后同 `msg_id` 新流成功，DONE 成功                         | 通过                                 |
| `LONG_TOOL_TEST`               | 03:07:54 | 5m                    | `/stop` 等待约 2m57s；`中途请求` 进入 steer 队列后被 abort 还原到编辑器 | `/stop` 阻塞已确认；steer 待单独测试 |
| `LONG_TOOL_TEST`（只测 steer） | 03:26:19 | 5m                    | 工具结束后 `中途请求` 交付，agent 正常回复                              | 通过                                 |
| `LONG_TOOL_ABORT_TEST`         | 03:52:06 | 61s 后 abort          | 工具返回 `aborted`，run 在约 61s 结束，未等满 300s                      | 通过                                 |
| `EXP: budget 6`                | 03:55:10 | 6.7s                  | 6 条普通文本全部成功；未出现 `40034128`                                 | 通过                                 |

### 5.2 空闲实验

`idle 2`：

- 首帧 `00:24:57`，`stream_msg_id=d2136394…`
- 探针 `00:26:57`，间隔 120.0s，成功
- 最终 DONE 成功，总耗时 127.5s

`idle 5`：

- 首帧 `00:28:59`，`stream_msg_id=fcb95d23…`
- 探针 `00:33:59`，间隔 300.0s，成功
- 最终 DONE 成功，总耗时 303.5s

`idle 10`：

- 首帧 `00:37:17`，`stream_msg_id=9c826686…`
- 探针 `00:47:17`，间隔 600.0s
- 返回：
  `{"code":40034020,"message":"同一流式消息发送超过时间限制"}`
- 实验失败，误差在 0.1s 内。

### 5.3 心跳实验

`heartbeat 10 1`：

- 首帧 `00:49:08`，`stream_msg_id=83e842d0…`
- 心跳 1–9 全部成功，最后成功在总耗时约 553s
- 第 10 次心跳 `00:59:09`，距流创建约 **600.0s**，返回 `40034020`
- 说明：连续每分钟发帧不能延长生命周期。

### 5.4 轮换实验

`rotate 5`：

- 首帧 `01:02:22`，旧流 `stream_msg_id=aa489d9b…`
- 300.0s 后主动发送 DONE，成功
- 同一 `msg_id` 开新流：新 `msg_seq=2`、新 `stream_msg_id=a54cf1eb…`、`index=0`
- 新流首帧和 DONE 都成功。

`rotate 8`：

- 首帧 `01:08:42`，旧流 `stream_msg_id=709a565d…`
- 480.0s 后主动 DONE，成功
- 同一 `msg_id` 新流：新 `msg_seq=2`、新 `stream_msg_id=8f20cd83…`
- 新流首帧和 DONE 都成功，距 600s 上限约 2 分钟。

### 5.5 过期恢复实验

`expire 10`：

- 首帧 `01:19:59`，旧流 `stream_msg_id=efea3833…`
- 旧探针 `01:30:00`，距首帧 600.0s，返回 `40034020`
- 立即用同一 `msg_id` 开新流：
  - 新 `msg_seq=2`
  - 新 `stream_msg_id=457ab710…`
  - `index=0`
- 新流首帧和 DONE 成功，总耗时 604.5s。

测试期间在 `01:29:07` 发过一条 `EXP: ping`，用于准备新入站目标；由于同 `msg_id` 新流已经成功，实验未继续走 `is_wakeup` 或新入站分支。

`expire-full 10`：

- 首帧 `02:48:21`，旧流 `stream_msg_id=9c6f4d9e…`
- 旧探针 `02:58:21.913`，距首帧 600.0s，**成功**
- 旧流下一帧 `02:58:22.5`，约 601s，返回 `40034020`
- 新流同 `msg_id`：`msg_seq=2`、`stream_msg_id=2f960389…`，成功
- `is_wakeup=true`：`msg_seq=3`、`stream_msg_id=0444004f…`，首帧和 DONE 成功
- 新入站目标（`02:57:34` 的 `EXP: ping`）：新流 `stream_msg_id=250f510c…`，成功
- 三条恢复路径全部成功，总耗时 605.6s

边界行为说明：600.0s 的探针仍可能成功，约 601s 的下一帧失败，说明阈值在 600s 附近有约 1s 的抖动，不能卡点轮换。

### 5.6 大帧回归

`large 5`：

- 内容 5568 字符 / 5570 B，单条 `markdown` 通过 `AppendStream` 发送
- P1 在换行处拆成两帧：
  - `index=0`：3371 字符
  - `index=1`：2197 字符
- 两帧均返回 200，`stream_msg_id=a4ef8d5a…`
- DONE 成功，总耗时 2.8s
- 未出现 `40034017`

说明 P1 的 3500 B 帧切分在真实 QQ 大帧路径上有效。注意该用例内容包含换行；无换行超大单行的硬切仍只由单测覆盖。

### 5.7 relay 长工具

`relay 10.5`：

- `02:32:55` 工具头开始，首帧 `index=0`、`msg_seq=1`、`stream_msg_id=ac48378e…`
- `02:43:25`（约 630s）旧流结果帧：
  - `index=1`、`msg_seq=1`、旧 `stream_msg_id`
  - 返回 `40034020`
- 紧接着 P1 新开流：
  - `index=0`、`msg_seq=2`、不带旧 `stream_msg_id`
  - 返回 200，新 `stream_msg_id=85b4c6a8…`
- 新流 DONE：`index=1`、`msg_seq=2`，返回 200
- `streamTookOver=true`

这是真实 `RunFeedback` / `BubbleWriter` 路径，证明长工具结果在旧流过期后能自动切到新流并送达。另有 `relay 12` 高层测试也返回 `streamTookOver=true`，但未保留帧级日志。

### 5.8 原日志回归分析

原日志 `pi-qq-2026-11-11.log`：

- `40034020`：`seq=237` 在 12:25:13 开流，直到 12:48:40 才发下一帧，间隔 23m27s；旧实现用同一个 `stream_msg_id` resume 两次，全部失败，最终熔断。
- `40034017`：新流首帧 4672 字符 / 4719 B，重试增长到 5044 / 5145 B、5062 / 5170 B；成功最大帧为 3706 字符 / 3743 B。
- 两次死流都靠 `/last` 恢复；最终文本 2202 / 1831 字，与流式帧重建结果一致，没有最终回答丢失。
- 原日志还显示：12:03:37 的入站消息，在 12:25:13 仍能创建新流（约 22 分钟后），与本次 `expire 10` 的“同 `msg_id` 新流成功”一致。

### 5.9 自动化验证

- `npm test`：24 files / 245 tests passed
- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm run format:check`：通过

相关测试覆盖了：

- 超大帧按 UTF-8 字节切分、无换行硬切；
- `40034020` 在已有 `stream_msg_id` 时新开流并重放 buffer；
- auto-rebind 到新鲜入站目标；
- `cancelPending` 清除待处理的 QQ 目标。

### 5.10 agent 长工具：steer 与 `/stop`

`LONG_TOOL_TEST`：

- `03:07:54` 从 QQ 收到 `LONG_TOOL_TEST`
- `03:07:57` agent 调用 `stream_test_sleep(300, ignoreAbort=true)`
- 工具持续 **300003ms**，`03:12:57` 结束
- `03:08:57` 收到普通消息 `中途请求`，pi-qq 记录 `sent to pi`；pi 把它加入 steering 队列，TUI 先显示为 pending steering
- `03:10:00` 收到 `/stop`，记录 `/stop wait start`
- `/stop` 调用 abort 后，TUI 的 abort handler 执行 `restoreQueuedMessagesToEditor`，所以 `中途请求` 被还原到输入框等待重新提交；它没有交付给模型
- 工具结束后 `03:12:57`，run 在 `03:12:58` 结束；因此 `/stop` 至少等待了 **约 2m57s**
- session JSONL 中没有 `中途请求`，因为它从未交付；这不是“没进入 steer 队列”，而是“进入队列后又被 abort 还原到编辑器”
- 日志在 run 结束后关闭，没有记录 `/stop wait done` 和后续回复；`/stop` 的实际回复时间需要 QQ 侧确认
- 工具结果帧 `slept 300s (ignoreAbort=true)` 在 `03:12:57` 成功发出，最终 stream DONE 成功

这个用例确认了 `/stop` 的阻塞路径。它**不能**用来判断正常 steer 的延迟，因为 `/stop` 在工具结束前 abort，steering 消息被还原到编辑器而没有交付。

`LONG_TOOL_TEST`（只测 steer，不发 `/stop`）：

- `03:26:19` 收到 `LONG_TOOL_TEST`，`03:26:22` 开始 300s 工具
- `03:27:23` 收到 `中途请求`，进入 steering 队列
- `03:31:22` 工具结束，工具结果写入
- `03:31:24` 模型开始处理 steering
- `03:31:26` assistant 回复 117 字，`streamTookOver=true`
- session JSONL 顺序为：工具结果 → `中途请求` user 消息 → assistant 回复

这证明 steer 正常工作：消息在工具运行期间排队，工具批次结束后交付；它不会在工具执行中途打断。第一次测试看到的输入框文本，是 `/stop` abort 后 TUI 把 queued steer 还原到编辑器的行为。

`LONG_TOOL_ABORT_TEST`（可 abort 工具）：

- `03:52:06` 收到命令，`03:52:09` 开始 300s 工具
- `03:53:10` 收到 `/stop`，工具在同一秒返回 `{"content":[{"type":"text","text":"aborted"}]}`
- 工具实际持续时间约 **61.1s**，没有等满 300s
- run 在 `03:53:11` 结束
- `/stop` 的 `wait done` 和回复日志仍受 log gate 影响没有落盘；QQ 侧回复时间需要确认，但工具 abort 快速路径已确认

对比：

- 不响应 abort 的 `LONG_TOOL_TEST`：`/stop` 等到约 2m57s 工具结束；
- 响应 abort 的 `LONG_TOOL_ABORT_TEST`：约 1s 内工具结束。

### 5.11 被动回复预算

`EXP: budget 6`：

- `03:55:10` 开始，目标为当前 `EXP: budget 6` 消息
- 连续发送 6 条普通文本，时间从 `03:55:11` 到 `03:55:16`
- 6 条全部返回成功
- 没有出现 `40034128`、`40034005` 或限流错误

注意：本实验直接调用 `sendWithMsgSeq`，没有经过 pi-qq 的本地 `ReplyBudget` 4 次限制，因此它验证的是平台侧行为；平台在这个个人 C2C 场景下接受了 6 条探针（外加实验启动通知），并不代表本地 4 次限制可以安全移除。

## 6. 分析

### 6.1 生命周期

`idle 10` 和 `heartbeat 10 1` 都在约 600.0s 失败，这是本次测试最强的证据：

- 不是“空闲 10 分钟”导致，因为每分钟心跳仍失败；
- 是从流创建开始计算的**总生命周期约 600 秒**；
- `expire-full 10` 在 600.0s 的探针成功、约 601s 的下一帧失败，说明边界有约 1s 抖动；
- 600 秒后旧 `stream_msg_id` 不可继续使用；实际轮换应留足余量。

### 6.2 `msg_id` 有效期

- `expire 10` 在旧流 600s 失败后，用同一 `msg_id` 立即开新流成功；
- `expire-full 10` 进一步验证同一 `msg_id`、`is_wakeup=true`、新入站目标三条路径都成功；
- 原日志在入站约 22 分钟后仍成功创建过新流；
- 说明 stream API 的 `msg_id` 有效期明显长于普通被动回复常见的 5 分钟窗口，至少本次测试范围内没有触发 `msg_id` 过期。

### 6.3 `40034017`

- P1 把单帧上限设为 3500 B，优先在换行处切分；
- 单测覆盖了 5K 级帧和无换行硬切；
- 2026-11-12 真实 QQ `large 5`：5568 字符 / 5570 B 拆成 3371 + 2197 两帧，均 200，无 `40034017`；
- 无换行超大单行的硬切仍只有单测覆盖，未在真实 QQ 上复测。

### 6.4 P1 覆盖范围

- `40034020`：P1 会新开流（新 `msg_seq`、`index=0`、不带旧 `stream_msg_id`），与 `expire 10` 验证的路径一致；
- 因此原日志中的 23 分钟工具结果帧，预计会在新流上发送成功，而不是像旧实现一样三次 resume 同一过期流；
- `relay 10.5` 已在真实 `RunFeedback` / `BubbleWriter` 路径上验证：旧流 40034020 后新流成功、DONE 成功、最终文本接管；
- auto-rebind 仍保留为兜底，但本次实验表明同 `msg_id` 新流已经足够，通常不会走到 rebind；
- watchdog 可以不实现；如果实现，应做 8 分钟轮换，而不是心跳。

## 7. 结论

1. `40034020` 是流的总生命周期限制，实测约 **600 秒**。
2. 心跳不能续命；5 分钟心跳方案无效。
3. 5 分钟 / 8 分钟主动轮换都可行，8 分钟距上限约 2 分钟。
4. 流过期后同 `msg_id` 新流可立即恢复；`is_wakeup=true` 和新入站目标也可恢复。P1 的 `40034020` 新开流逻辑足够覆盖原 23 分钟场景。
5. `40034017` 的帧切分已通过真实 5.5KB 大帧回归；无换行超大单行硬切仍只有单测。
6. 不建议默认开启 watchdog；若需要消除首次失败帧，可提供默认关闭的 8 分钟轮换配置。
7. `LONG_TOOL_TEST` 确认：不响应 abort 的长工具会让 `/stop` 等待约 3 分钟；可 abort 工具则约 1 秒结束。steer 在工具结束后正常交付；第一次测试输入框里的文本是 abort 后 TUI 还原的 queued steer。
8. `EXP: budget 6` 的 6 条普通文本全部成功，没有触发 `40034128`；平台侧在当前个人 C2C 场景下未表现出 4 条硬限制，但本地 `ReplyBudget` 仍保守限制为 4。

## 8. 建议

- 保留当前 P1：帧切分、`40034020` 新开流、auto-rebind。
- 不默认实现 watchdog；如果后续要优化体验，增加 `streamRotateAfterMs`，默认关闭，建议值 480000（8 分钟）。
- 保留 `/last` 作为手动兜底。
- 同 `msg_id`、`is_wakeup=true`、新入站目标三条恢复路径均已验证；日常优先同 `msg_id` 新流，auto-rebind 作为兜底。
- 真实大帧回归已完成（`EXP: large 5`）；如需覆盖无换行超大单行，再补一次硬切场景。
- 真实 `RunFeedback` / `BubbleWriter` 长工具回归已完成（`relay 10.5`）；如需覆盖真实 agent 的 prompt/工具链，再做一次 12 分钟 agent 工具测试。
- 后续如要覆盖 20 分钟以上，再测试 `expire 20`；当前原日志 22 分钟创建成功已提供强证据，但不是本次实验的直接用例。

## 9. 未覆盖与风险

- 范围仅个人 C2C；群聊不适用。单 bot、单用户、单网络环境，未测试并发、多用户。
- 被动预算只验证了 6 条直发；未验证长时间、大量普通回复下的平台限流，也未验证本地 `ReplyBudget` 与平台限制的边界。
- `/stop` 阻塞和可 abort 快速路径均已确认；`/stop wait done` 与回复日志受 log gate 影响未落盘，QQ 侧回复时间待确认。
- steer 交付已验证：工具结束后 queued steer 正常进入模型并得到回复。pi 的 abort 会把 queued steer 还原到编辑器，这是 TUI 行为，不是实验代码丢消息。
- `is_wakeup=true` 和新入站目标已由 `expire-full 10` 验证。
- 真实 QQ 已复测 5.5KB 带换行大帧；未复测无换行超大单行的硬切路径。
- 完整 `BubbleWriter` 已通过 `relay 10.5` 验证；真实 agent 的 5 分钟非 abortable 工具已用于确认 `/stop` 阻塞，但尚未做 12 分钟 agent 长工具。
- 平台行为可能随账号、地区、版本变化；600 秒边界有约 1s 抖动，`msg_id` 有效期需要持续观察。
- 测试环境使用了 `PI_QQ_EXPERIMENTS=1` 调试钩子和本地扩展，不属于发布产物。

## 10. 附录

### 10.1 实验命令

```text
EXP: help
EXP: idle <minutes>
EXP: heartbeat <minutes> [intervalMinutes]
EXP: expire <minutes>
EXP: rotate <minutes>
EXP: large [kb]
EXP: budget [count]
EXP: relay <minutes>
EXP: expire-full <minutes>
EXP: status
EXP: stop
EXP: ping
```

### 10.2 日志

- 实验帧日志：`~/project/mine/pi-qq-test/.pi/pi-qq/experiments/exp-2026-11-12.jsonl`
- pi-qq 运行日志：`~/project/mine/pi-qq-test/.pi/pi-qq/experiment-logs/pi-qq-2026-11-12.log`
- 原始回归日志：`~/project/mine/pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-11.log`

### 10.3 相关提交

- `d559a91`：帧切分、`40034020` 新开流、auto-rebind
- `fed99df`：实验调试钩子
- `5927b78`：登录失败日志与提示
- `4912810`、`82352b4`、`9fc64bf`、`7e3eb54`：实验记录与结论
