# 具体任务

> 只记录待执行或进行中的具体任务；完成后直接删除。
> 背景与调研：`doc/investigate.md`；测试结果：`doc/test-report.md`；长期项目：`doc/todo.md`。

## 1. typing 超时隔离

**状态：未开始。**

**背景：** 原日志中两次 `typing`（`msg_type:6`）连接超时 10s；第一次与模型错误后的 30s 延迟重合。可能存在 SDK 串行发送被 typing 阻塞的问题，但尚未复现。

**下一步：** 在实验环境构造 typing 超时，观察流帧是否被延迟；确认后再决定是否隔离 typing 请求或降低心跳频率。

## 2. run 触发消息未入日志

**状态：未开始。**

**背景：** log gate 只在 QQ run 活跃时打开，导致触发 run 的 inbound 消息本身没有写入日志；run 1 / run 2 的触发内容缺失。

**下一步：** 在 inbound 到达时先记录元数据，或缓冲最后一条 inbound 并在 run 开始时落盘；补测试。

## 3. 日志脱敏

**状态：未开始。**

**背景：** 日志中的工具命令和结果包含本地 DB 凭据、临时账号密码、Redis 会话键等敏感信息。

**下一步：** 对 `password`、`token`、`secret`、`session`、`-p...` 等模式做脱敏；保留调试所需的结构化字段；补测试。

## 4. `append: while flushing` 日志降噪

**状态：未开始。**

**背景：** 18 MB 日志中约 4,945 行是 `append: while flushing`，约占 27%。

**下一步：** 按 flush 聚合、每 N 次记录一次，或降到 trace；确保不影响流式排障。
