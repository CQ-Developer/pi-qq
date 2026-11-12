# 具体任务

> 记录具体任务和状态；已完成项保留并标记，不删除。
> 背景与调研：`doc/investigate.md`；测试结果：`doc/test-report.md`；长期项目：`doc/todo.md`。

## 1. 验证 20 分钟以上同 `msg_id` 新流

**状态：已完成（2026-11-12）。** 旧流在 1200.0s 返回 `40034020`，同一 `msg_id` 新流成功；`EXP: ping` 未在 19 分钟发送，但新入站分支已在 `expire-full 10` 验证，不影响本结论。

**背景：** 已知流总生命周期约 600s；10 分钟和 12 分钟场景已恢复成功；原日志有入站 22 分钟后创建新流的证据。

**结果：** 新 `msg_seq=2`、新 `stream_msg_id=b139dd07…`，DONE 成功，总耗时 1203.5s。

## 2. 被动回复预算 10 条

**状态：已完成（2026-11-12）。** 10 条普通文本全部成功，总耗时约 10.6s，没有 `40034128`。

**背景：** `EXP: budget 6` 的 6 条直发全部成功；实验绕过本地 `ReplyBudget`，需要确认第 7–10 条是否触发平台限制。

**结果：** 平台侧接受 10 条探针（外加启动通知）；本地 4 次 `ReplyBudget` 限制保持不变。

## 3. `/stop wait done` 与后台日志

**状态：已关闭，无需实施（2026-11-12）。** `/stop` 已在真实 agent 中约 1ms 回复“已请求中止”；`outbound` 日志已证明立即回复。`waitForEnd()` 的后台完成日志会被 log gate 截断，但没有功能影响，因此不再作为任务。

## 4. typing 超时隔离

**状态：已完成（代码与单测）；真实网络超时未复现。**

**背景：** 原日志中两次 `typing`（`msg_type:6`）连接超时 10s；第一次与模型错误后的 30s 延迟重合。可能存在 SDK 串行发送被 typing 阻塞的问题，但尚未复现。

**下一步：** 在实验环境构造 typing 超时，观察流帧是否被延迟；确认后再决定是否隔离 typing 请求或降低心跳频率。

**结果：** `BubbleWriter` 已暴露 `hasActiveStream`；`RunFeedback` 在流活跃时跳过 typing，避免与流式发送争用 API 客户端；已补单测。真实网络超时仍待环境复现。

## 5. run 触发消息未入日志

**状态：已完成（代码与单测）。**

**背景：** log gate 只在 QQ run 活跃时打开，导致触发 run 的 inbound 消息本身没有写入日志；run 1 / run 2 的触发内容缺失。

**下一步：** 在 inbound 到达时先记录元数据，或缓冲最后一条 inbound 并在 run 开始时落盘；补测试。

**结果：** log gate 在登录后允许 `inbound`，触发 run 的消息会先落盘；已补 index 测试。真实 QQ 的下一次会话可直接确认 msgId 和内容长度。

## 6. 日志脱敏

**状态：已完成（代码与单测）。**

**背景：** 日志中的工具命令和结果包含本地 DB 凭据、临时账号密码、Redis 会话键等敏感信息。

**下一步：** 对 `password`、`token`、`secret`、`session`、`-p...` 等模式做脱敏；保留调试所需的结构化字段；补测试。

**结果：** `file-logger` 已增加递归脱敏和文本脱敏，覆盖日志字段、`previewForLog` 和 `msg`；测试密码、Bearer、Cookie、`mysql -p`、Redis session key。

## 7. `append: while flushing` 日志降噪

**状态：已完成（代码与单测）。**

**背景：** 18 MB 日志中约 4,945 行是 `append: while flushing`，约占 27%。

**下一步：** 按 flush 聚合、每 N 次记录一次，或降到 trace；确保不影响流式排障。

**结果：** `AppendStream` 每次 flush 只记录首条和每 50 条 `append: while flushing`，已补单测。

## 8. 更新文档与 CHANGELOG

**状态：已完成。**

**结果：** 已更新 `CHANGELOG.md`、`doc/test-report.md`、`doc/investigate.md` 和本文件状态；验证见测试报告。
