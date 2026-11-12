# pi-qq 流式消息修复交接

> 日期：2026-11-12
> 状态：测试与代码修改完成；真实 QQ 的 metadata-only 日志验证待做
> 分支：`main`，本地领先 `origin/main` 33 个提交（不含本 handoff 文档）
> 工作区：干净
> 说明：这是一次性交接快照；后续工作看 `doc/task.md` 和 `doc/todo.md`。

## 1. 本次完成的工作

### 1.1 `40034017` 大帧

- `AppendStream` 单帧上限改为 **3500 B**；
- 优先在最后一个 `\n` 处切帧；
- 无换行的超长单行硬切并补 `\n`；
- 真实 QQ 验证：
  - `large 5`：5568 字符拆成 3371 + 2197 两帧，成功；
  - `large-line 5`：5121 B 无换行单行拆成 3500 + 1622 两帧，成功；
  - 均无 `40034017`。

代码：`src/relay/stream-session.ts`
提交：`d559a91`

### 1.2 `40034020` 流过期

真实 QQ 实验确认：

- 流总生命周期约 **600 秒**，边界有约 1 秒抖动；
- 每分钟心跳不能延长生命周期；
- 5 分钟 / 8 分钟主动轮换都成功；
- 过期后同 `msg_id` 新流、`is_wakeup=true`、新入站目标都能恢复；
- 20 分钟后同 `msg_id` 新流仍成功；
- 12 分钟真实 agent 工具结束后，旧流 `40034020`，P1 自动新开流并送达结果和最终回答。

实现：

- `BubbleWriter` 对 `40034020` 开新流：新 `msg_seq`、`index=0`、不带旧 `stream_msg_id`；
- `RunFeedback` 保留 auto-rebind 兜底；
- 不默认实现 watchdog；8 分钟轮换是可选体验优化。

代码：`src/relay/bubble-writer.ts`、`src/relay/run-stream-relay.ts`
提交：`d559a91`

### 1.3 `/stop` 非阻塞

真实 agent 验证：

- 不响应 abort 的 5 分钟工具：旧实现 `/stop` 等待约 2m57s；
- 修复后：`/stop` 在约 **1ms** 内回复“已请求中止”，工具仍继续运行；
- 可 abort 工具：约 61s 后返回 `aborted`。

实现：

- `ctx.abort()` 后立即回复；
- `waitForEnd()` 只做后台日志，不再阻塞回复；
- 补测试：`waitForEnd` 永不 resolve 时 `/stop` 仍立即返回。

代码：`src/qq/inbound-command.ts`
提交：`b81bbc4`

### 1.4 日志与 typing

- 日志改为**扩展运行元数据**，不再记录用户消息正文、工具参数、完整工具结果、assistant 文本或 SDK body；
- inbound、tool、assistant、SDK body 都只记录时间、ID、长度、数量、耗时、状态、错误码；
- log gate 在登录后允许 `inbound`，触发 run 的消息会先落盘；
- SDK body 只记录长度；
- `append: while flushing` 每次 flush 只记录首条和每 50 条；
- 流活跃时跳过 typing，避免和流式请求争用 API 客户端；
- 脱敏保留为错误消息和少量字段的兜底。

代码：`src/infra/file-logger.ts`、`index.ts`、`src/qq/qq-bot.ts`、`src/qq/qq-message-handler.ts`、`src/qq/reply-sender.ts`、`src/relay/stream-session.ts`、`src/relay/bubble-writer.ts`、`src/relay/run-stream-relay.ts`
提交：`aa9d22a`、`2b6878f`

### 1.5 文档与环境清理

- 文档重整为：
  - `doc/investigate.md`：调研、背景、假设、watchdog 方案；
  - `doc/test-report.md`：完整测试报告；
  - `doc/task.md`：具体任务和状态；
  - `doc/todo.md`：只保留未完成长期项目，不使用勾选。
- 实验环境 `pi-qq-test`、本地实验扩展、脚本、实验日志、`PI_QQ_EXPERIMENTS` 调试钩子已清理；
- 文档保留，失效的日志路径已在文档中标注。

提交：`dc9542e`、`24e98ad`

## 2. 测试结果摘要

| 项目                    | 结果                         |
| ----------------------- | ---------------------------- |
| 流生命周期              | 约 600s，边界约 1s 抖动      |
| 心跳                    | 不能续命，第 10 次心跳仍过期 |
| 5 / 8 分钟轮换          | 成功                         |
| 过期后同 `msg_id` 新流  | 成功                         |
| `is_wakeup=true`        | 成功                         |
| 20 分钟同 `msg_id` 新流 | 成功                         |
| 12 分钟真实 agent 工具  | 成功自动新开流并送达结果     |
| 5.5KB 带换行大帧        | 成功                         |
| 5KB 无换行单行          | 成功硬切                     |
| steer                   | 工具结束后正常交付           |
| `/stop` 非 abort 工具   | 修复后约 1ms 回复            |
| `/stop` 可 abort 工具   | 约 61s 返回 aborted          |
| 被动预算 6 / 10 条      | 全部成功，无 `40034128`      |

自动化验证：

- `npm test`：24 files / **250 tests passed**
- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm run format:check`：通过

## 3. 下一步

### P1：真实 QQ 日志验证

- 在一次正常 QQ 会话中发送一条消息，并执行一次工具；
- 检查 `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`：
  - 有 event、time、contentLength、attachmentCount、toolName、durationMs、isError、resultLength、错误码；
  - **没有**消息正文、工具参数、完整结果、assistant 文本、SDK body；
- 完成后更新 `doc/task.md` 任务 9 的真实 QQ 验证状态。

### P2：typing 真实网络超时

- 当前只在流活跃时跳过 typing，属于缓解；
- 尚未复现“typing 10s 超时导致流帧延迟”的路径；
- 如再次出现，记录 typing 请求时间、流帧时间、耗时，再决定是否隔离 API 客户端。

### P3：长期项目

`doc/todo.md` 当前只剩：

- QQ 工具启动行的渲染确认（TODO 1）；
- 超过 20 分钟的同 `msg_id` 新流；
- 1 小时以上 `msg_id`；
- 平台生命周期、网络抖动 / 重连 / 限流的长期观察。

### 发布

- `CHANGELOG.md` 已更新 `[Unreleased]`；
- 尚未 bump 版本、打 tag 或推送；
- 按 `AGENTS.md`：发布必须通过 GitHub Actions，不要手动 `npm publish` 或手动创建 GitHub Release。

## 4. 相关资源

### 代码

- `src/relay/stream-session.ts`：帧切分、flush、DONE；
- `src/relay/bubble-writer.ts`：`40034020` 新流、active stream、日志；
- `src/relay/run-stream-relay.ts`：auto-rebind、typing 跳过；
- `src/qq/inbound-command.ts`：`/stop` 非阻塞；
- `src/infra/file-logger.ts`：gate、metadata、脱敏、SDK body 摘要；
- `index.ts`：inbound 日志 gate、工具/assistant 日志；
- `src/qq/qq-bot.ts`、`src/qq/qq-message-handler.ts`、`src/qq/reply-sender.ts`：inbound/outbound 元数据。

### 测试

- `test/relay/stream-session.test.ts`
- `test/relay/bubble-writer.test.ts`
- `test/relay/run-stream-relay.test.ts`
- `test/qq/qq-message-handler.test.ts`
- `test/infra/file-logger.test.ts`
- `test/index.test.ts`

### 文档

- `doc/investigate.md`：调研和背景；
- `doc/test-report.md`：测试报告；
- `doc/task.md`：具体任务和进度；
- `doc/todo.md`：未完成长期项目；
- `CHANGELOG.md`：Unreleased 变更。

### 官方资料

- 流式接口：`https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html`
- 错误码：`https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html`

## 5. Git 记录

当前分支：`main`
基线：`7bf1c06 chore: release 1.7.0`
远端：`origin/main`
状态：领先 33 个提交（不含本 handoff 文档），工作区干净。

```text
24e98ad chore: remove QQ stream experiment environment
2b6878f refactor: log metadata instead of user content
d2d8774 docs: plan metadata-only logging
aa9d22a feat: harden relay logging and typing
36fd6ac docs: retain completed tasks with status
3cb8c12 docs: remove diagnostic stop-wait task
77c43e9 docs: record 10-message budget test
9b5316a docs: record 20-minute stream recovery
dc9542e docs: split investigation, test report, and tasks
0e84185 docs: verify 12-minute agent tool end to end
920b2e2 docs: verify no-newline large frame
e03e43a docs: verify immediate stop reply with real agent
db431a5 docs: mark non-blocking stop as implemented
b81bbc4 fix: make /stop reply without waiting for run end
52d8440 docs: list remaining validation items
e374caf docs: record passive reply budget test
ab4fbcf docs: verify abortable long tool stop
d77f71b docs: verify steer delivery after long tool
3855b22 docs: clarify steer restoration on abort
3a7bda2 docs: correct steer test interpretation
da36552 docs: record steer and stop blocking test
e3eaa19 docs: record full expired-stream recovery paths
a54b95c docs: record relay stream recovery
e4dc9e5 docs: record live large-frame regression
59598c6 docs: remove resolved long-running tool TODO
9240e32 docs: add QQ stream timeout test report
7e3eb54 docs: record stream recovery after expiry
9fc64bf docs: confirm 8-minute stream rotation
82352b4 docs: record successful 5-minute stream rotation
4912810 docs: record QQ stream lifetime experiments
5927b78 fix: log QR login failures before login
fed99df test: add opt-in QQ stream experiment hook
d559a91 fix: recover oversized and expired QQ stream frames
```

注意：`fed99df` 添加的实验钩子已被 `24e98ad` 清理，仅保留在 Git 历史中。
