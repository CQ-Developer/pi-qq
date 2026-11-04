# 工具启动信息延迟回传调研

> 状态：调研/设计文档，尚未实现
> 日期：2026-11-04
> 涉及版本：pi-qq 1.3.5
> 现象：工具开始执行后，QQ 侧要等到工具结束才一起看到工具名称、参数和结果；希望工具名称和参数在 `tool_execution_start` 时立即回传。

## 1. 问题

当前 QQ 侧的工具气泡通常是“工具名称 + 参数 + 结果”一起出现，而不是：

1. 工具一开始执行，就先显示名称和参数；
2. 工具结束后，再补充结果。

这会让用户误以为工具没有开始，尤其在工具执行时间短、但结果返回稍慢时。

## 2. 现象与证据

### 2.1 日志时间线

测试日志：

```text
/home/chen/project/pi-qq-test/.pi/pi-qq/logs/pi-qq-2026-11-04.log
```

其中一次 bash 工具的时间线：

```text
06:34:36.068  tool start  bash  which playwright-cli ...
06:34:36.414  tool end    bash  (0.3s)
06:34:36.827  stream      bubble split
```

工具在 `36.068` 开始，`36.414` 结束，直到 `36.827` 才发生流式气泡切分/刷新。
也就是说，工具启动信息没有在 `36.068` 立即形成可见的 QQ 流式帧，而是和后续结果一起进入了同一次发送窗口。

另一个长工具：

```text
06:34:38.295  tool start  bash  playwright-cli open ...
06:34:38.777  stream      bubble split   (约 482ms 后)
06:34:42.014  tool end
```

这个工具的启动行在约 500ms 后才被刷新。

### 2.2 当前代码路径

`index.ts` 收到 `tool_execution_start` 后调用：

```ts
void runFeedback.onToolStart(event.toolName, event.args, event.toolCallId);
```

`RunFeedback.onToolStart()` 把工具加入队列并调用 `startNextTool()`：

```ts
run.tools.push({ id, name, toolName, args, started: false, finished: false });
this.startNextTool(run);
```

`startNextTool()` 调用：

```ts
run.writer.pushTool(tool.name, tool.args);
```

`BubbleWriter.pushTool()` 把工具行包装成一次普通的 `push()`：

```ts
this.push(`${prefix}${formatToolLine(name, args)}\n\n`, ...);
```

`push()` 只是把 append 操作排入队列：

```ts
await stream.append(outgoing);
```

这里没有调用 `stream.flush()`。

### 2.3 关键原因：`AppendStream` 的节流缓冲

`src/relay/stream-session.ts` 的 `append()`：

```ts
this.buffer += delta;
const elapsed = Date.now() - this.lastFlushAt;
if (this.flushing) return;
if (elapsed >= this.throttleMs()) {
  await this.doFlush("generating");
  return;
}
if (!this.flushTimer) {
  this.flushTimer = setTimeout(() => {
    this.flushTimer = null;
    void this.doFlush("generating").catch(...);
  }, this.throttleMs() - elapsed);
}
```

默认节流窗口是 500ms（最小 300ms）。因此：

- 如果上一次流式帧刚刚发送，工具启动行会先进入 buffer；
- 工具在 500ms 内结束，结果也进入同一个 buffer；
- 定时器到点后，工具行和结果被一起发送。

这就是“工具名称和参数等结果一起出现”的直接原因。

### 2.4 500ms 到点后，是否还要等工具结束？

不需要。500ms 定时器是普通 Node 定时器，**不依赖工具 Promise 完成**；只要事件循环没有被工具阻塞，它会在 500ms 左右触发并把 buffer 发出。

上面的长工具日志可以证明这一点：

```text
06:34:38.295  tool start  bash
06:34:38.777  POST stream_messages  content_raw: "**💻 bash** ..."
06:34:42.014  tool end
```

启动行在 `38.777` 已经通过 `stream_messages` 发出，此时工具还在执行，直到 `42.014` 才结束。因此：

- **长工具**：启动行会在约 500ms 后先发出，不会等结果；
- **短工具**：结果在 500ms 内进入同一 buffer，才会和启动行一起发出；
- **真正会等到工具结束的情况**：工具同步阻塞了 Node 事件循环，定时器无法触发；或使用并行工具时被 `activeTool` 串行策略挡住。

`bash`、`read` 等 pi 内置工具使用异步子进程/文件 IO，不会阻塞事件循环；CPU 密集的自定义工具、同步插件代码可能阻塞，需要单独排查。

### 2.5 第二个原因：并行工具被串行排队

`RunFeedback.startNextTool()` 有一个 `activeTool` 保护：

```ts
if (run.writer.dead || run.activeTool) return;
```

只有当前工具结束后，才会启动下一个工具的输出：

```ts
run.activeTool = undefined;
this.startNextTool(run);
```

因此，当 pi 并行启动多个工具时：

- 第一个工具的启动行会先进入队列；
- 第二个工具的启动行要等第一个工具结束；
- 用户看到的工具启动信息仍然是串行的。

对单个工具来说，主因是 `AppendStream` 节流；对并行工具来说，还有 `RunFeedback` 的串行输出策略。

### 2.6 长 e2e 命令只显示 `bash` + 一个点

用户反馈：bash 执行 e2e 测试数分钟时，QQ 上只看到 `bash` 和一个点，看不到命令参数。

这不是“等待结果后一起推送”的典型表现；如果长时间工具已经超过 500ms，启动帧通常已经发出（前面的日志已验证）。需要区分：

1. **启动帧确实包含命令，但 QQ 只渲染出一个点/省略号**
   - `formatToolLine()` 把命令放在行内代码中，并对参数做 200 字符截断，末尾是 `…`；
   - 超长命令、包含反引号或特殊 Markdown 字符时，QQ 可能折叠/截断行内代码，只留下一个小点或省略号；
   - 此时日志中的 `POST stream_messages` 的 `content_raw` 仍然应该包含完整或截断后的命令。

2. **启动帧没有命令参数**
   - `tool_execution_start` 的 `args` 缺失/不是 `{command: string}`；
   - `formatToolLine()` 的 `primaryArg()` 没有取到 `command`；
   - 需要检查 `scope":"tool"` 的 `toolStart` 日志和同时间的 `stream_messages` 请求体。

3. **启动帧没有在 500ms 后发出**
   - 工具/主进程阻塞了 Node 事件循环；
   - 并行工具被 `activeTool` 串行策略挡住；
   - 需要看日志中 tool start 后是否有 `stream_messages` POST。

当前工作区没有该次 e2e 的日志（`pi-qq-test` 只有 14:34 的一次运行），因此还无法确认是 1、2 还是 3。需要用户提供：

- e2e 的 bash 命令或 QQ 截图；
- 对应时间段的 `pi-qq-YYYY-MM-DD.log`；
- `scope":"tool"` 的 `toolStart` 行；
- 紧随其后的 `POST .../stream_messages` 的 `content_raw`。

如果确认是长命令渲染问题，建议把工具参数从行内代码改为 fenced code block，或只显示命令摘要，避免 QQ 把长行内代码折叠成一个点。

## 3. 影响

- 用户无法从 QQ 判断工具是否已经开始执行；
- 工具参数在结果出现前不可见，降低了可观测性；
- 长工具和短工具的体验不一致：
  - 短工具：名称、参数、结果一起出现；
  - 长工具：约 500ms 后才出现启动行；
- 与 pi TUI 的工具执行状态不一致。

## 4. 解决方案

### 4.1 工具启动后立即 flush

在 `BubbleWriter.push()` 增加一个 `flushAfter` 参数：

```ts
private push(
  text: string,
  blockBoundary = false,
  endTool = false,
  newBubble = false,
  thinking = false,
  flushAfter = false,
): void
```

在 append 成功后，如果 `flushAfter` 为 true，调用：

```ts
await stream.flush();
```

`pushTool()` 传入 `flushAfter = true`：

```ts
this.push(
  `${prefix}${formatToolLine(name, args)}\n\n`,
  ...,
  true, // flushAfter
);
```

这样工具启动操作会在同一队列任务内完成 append + flush，结果操作排在它之后，不会被合并到同一个 buffer。

需要注意：

- `flush()` 本身会立即发送当前 buffer，不受 500ms 节流限制；
- flush 失败要进入现有 `handleStreamError()` 流程；
- 不需要对每个文本 delta 都 flush，只对工具启动行做；
- 如果工具启动行和上一条文本在同一气泡，flush 也会把上一条文本一起发出，这是可接受的。

### 4.2 处理并行工具启动

如果希望并行工具也能立即显示启动行，需要把“启动行发送”和“结果发送”解耦：

- 在 `onToolStart()` 中立即发送启动行；
- 在 `onToolEnd()` 中发送结果；
- 用 `tool.startLineSent` 避免重复；
- 结果仍可按工具完成顺序或启动顺序输出。

第一版可以只做 4.1，解决单工具的“启动行等结果”问题；并行工具的启动延迟作为后续优化。

### 4.3 不建议的方案

- **降低 throttle 到 0**：会增加 QQ 流式 API 调用频率，且不能保证工具启动瞬间发送；
- **在 `pushToolResult()` 里 flush**：只能让结果更快，不能解决启动行延迟；
- **每个 delta 都 flush**：网络调用过多，容易触发限流；
- **把工具启动和结果拆成两个独立消息**：会破坏现有同泡工具时间线，且增加消息数量。

## 5. 测试计划

### 单元测试

1. 在 `BubbleWriter` 测试中注入一个记录 `flush` 的 fake stream，验证：
   - `pushTool()` 后立即调用 `flush()`；
   - `pushText()` 不会额外 flush；
   - `pushToolResult()` 不会把启动行和结果合并。
2. 用 fake timers 模拟 500ms 节流窗口：
   - 工具启动后立刻检查 flush 调用；
   - 工具结束后结果仍然追加到同一气泡。
3. 现有 relay 测试继续通过：
   - 工具顺序；
   - 并行工具结果归属；
   - 流式熔断 fallback。

### 集成验证

在 `pi-qq-test` 中执行一个 300ms 左右的 bash 工具，记录：

- `tool start` 时间；
- QQ 上工具名称/参数出现时间；
- `tool end` 时间；
- 结果出现时间。

目标是：

```text
tool start -> QQ 立即显示工具名称和参数
tool end   -> QQ 再显示结果
```

## 6. 执行计划

### Phase 1：单工具立即 flush

- [ ] `BubbleWriter.push()` 增加 `flushAfter`；
- [ ] `pushTool()` 启用 `flushAfter`；
- [ ] flush 错误进入 `handleStreamError()`；
- [ ] 补测试。

### Phase 2：并行工具（可选）

- [ ] `ToolCall` 增加 `startLineSent`；
- [ ] `onToolStart()` 立即发送启动行；
- [ ] 处理结果顺序和重复；
- [ ] 补并行测试。

### Phase 3：验证

- [ ] lint / typecheck / test / format；
- [ ] 在 `pi-qq-test` 中复测短工具和长工具；
- [ ] 对比 QQ 时间线与日志时间戳。

## 7. 变更文件

| 文件                                  | 变更                                     |
| ------------------------------------- | ---------------------------------------- |
| `src/relay/bubble-writer.ts`          | `push()` 增加 `flushAfter`；工具启动刷新 |
| `src/relay/stream-session.ts`         | 复用现有 `flush()`，不改节流算法         |
| `test/relay/run-stream-relay.test.ts` | 工具启动立即 flush 测试                  |
| `doc/tool-return.md`                  | 本文档                                   |

## 8. 待确认问题

1. 并行工具是否要求每个工具启动行都立即显示，还是先只解决单工具。
2. 工具启动行 flush 是否接受额外的 QQ 流式 API 调用；一般工具数量不多，建议接受。
3. 工具启动行和结果是否继续在同一个气泡中；当前设计保持不变。
