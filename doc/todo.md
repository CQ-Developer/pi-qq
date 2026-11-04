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
- 如果是长命令渲染问题，考虑把参数从行内代码改成 fenced code block，或显示更短的命令摘要。
- 如果是 e2e CPU 导致的事件循环饥饿，需要评估 TUI/tool output 的同步开销，或把 relay 移出主进程。
- 修复后补测试、更新 `doc/tool-return.md`，再发布版本。
