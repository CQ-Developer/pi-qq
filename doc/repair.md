# `/last` 修复：运行快照与流式发送解耦

> 状态：已实现
> 目标：`replyType = "full"` 时，run 进行中的 `/last` 不再等待 assistant 文本，而是立即推送当前思考、工具和已有文本
> 相关文件：`src/relay/run-timeline.ts`、`src/relay/run-stream-relay.ts`、`src/relay/bubble-writer.ts`、`src/qq/inbound-command.ts`
> 日志依据：`pi-qq-2026-11-11.log`

## 1. 问题

修复前，`/last` 在 run 进行中只调用 `RunFeedback.repushCurrent()`，而该函数要求 `run.currentText` 非空：

```ts
const text = run?.currentText;
if (!run || !text?.trim()) return false;
```

`currentText` 只保存 assistant 文本，不包含思考块和工具块。因此在工具阶段或思考阶段执行 `/last` 时：

- 没有可重推的文本，直接返回 `false`；
- 命令层忽略返回值，QQ 侧没有任何回复；
- 即使 stream writer 已经 `dead`，也不会尝试恢复。

### 1.1 日志证据

2026-11-11 的 26 分钟 run 中：

```text
13:01:44.212  last repush ignored  textLength=0  currentTextLen=0
13:04:21.233  last repush ignored  textLength=0  currentTextLen=0
```

两次 `/last` 时：

- `writer.dead = true`
- `writer.resumeAttempts = 2`
- `currentTextLen = 0`
- `deferredTextLen = 0`
- `budget.remaining = 4`

第一次 assistant 文本直到 `13:09:56` 才出现，已经在两次 `/last` 之后。用户侧因此表现为“`/last` 没有任何反应”。

### 1.2 根因

1. 重推条件错误地绑定到 assistant 文本。
2. 运行内容状态和流式发送耦合在 `RunFeedback` 里：writer 死亡后，工具事件直接提前返回，当前工具状态丢失。
3. `BubbleWriter` 只有 `restartText()`，没有重推思考/工具的结构化接口。
4. `restartPush()` 的返回值没有被命令层处理，失败时静默。

## 2. 目标与非目标

### 2.1 目标

- `replyType = "full"` 且 run 进行中时，`/last` 立即向新的 `msgId` 推送当前快照：
  - 最新思考；
  - 当前工具及最近完成的工具；
  - 当前已有 assistant 文本。
- 快照不依赖 assistant 文本；只有思考或工具时也能推送。
- writer 已 `dead` 时，`/last` 创建新流并恢复后续输出。
- 重推后，后续 delta、工具结果和最终文本继续写入新流。
- 不重复推送重推后的新内容。
- `replyType` 只保留 `full` 和 `simple`；`simple` 的 `/last` 仍只重推文本。

### 2.2 非目标

- 不修复 `msgseq` 随机碰撞导致的 `40054005`；这是独立缺陷。
- 不重放整个 run 的全部历史，只推送有界的“当前快照”。
- 不把 `/last` 改成持续进度流；它仍是一次手动重推。
- 不增加工具的部分输出（`tool_execution_update`）转发。

## 3. 源码调研结论

调研基于：

- `/home/chen/project/github/pi`，已更新到 `4839e41d6`
- `/home/chen/project/github/qqbot-nodejs`，`1.0.5`

关键结论：

1. **pi 的 `message_update` 携带完整实时 assistant 消息。**
   `event.message.content` 已包含当前的 `thinking`、`text`、`toolCall` 块；`tool_execution_start/end` 携带工具参数和结果。继续在扩展内维护快照即可，不需要新增 pi API。

2. **session 历史不适合实时快照。**
   `sessionManager.getBranch()` 中的 assistant 消息在 `message_end` 后才持久化；工具执行中的当前消息不在 session 历史里。`/last` 不能依赖 session 查询。

3. **新的流式气泡会生成新的 `msg_seq`。**
   新的 `AppendStream` 会重新生成 `msg_seq`，足以从当前的 `writer.dead` 状态恢复；但不修复随机 `msg_seq` 碰撞本身。`qqbot-nodejs` 的 `getNextMsgSeq()` 只产生 `0..65535` 的随机值。

4. **`/last` 的目标消息足够新。**
   QQ `stream_messages` 要求基于 5 分钟内的入站消息；`repushCurrent(openid, msgId)` 使用 `/last` 这条入站命令的 `msgId`，满足时效要求。

5. **继续使用自定义 `AppendStream`。**
   `qqbot-nodejs` 的高层 `StreamSession` 是单条消息的 `input_mode=replace` 全文改写，不适合 pi-qq 的多气泡块输出；修复扩展现有 `BubbleWriter`，而不是替换流式实现。

## 4. 架构调整

修复没有在 `repushCurrent()` 里追加判断，而是把运行内容和发送通道拆开：

```text
pi events
  -> RunFeedback               编排：策略、deferred、writer 生命周期
       -> RunTimeline          纯状态：思考、文本、工具、activeTool、快照
       -> BubbleWriter         纯发送：格式化、切泡、重推、流恢复
```

### 4.1 `RunTimeline`

新增 `src/relay/run-timeline.ts`，作为单个 QQ run 的内容模型，不依赖 writer、budget 或 reply policy。

状态：

```ts
interface TimelineTool {
  id: string;
  name: string;
  args?: unknown;
  result?: { isError: boolean; result?: unknown };
  skillName?: string;
  startedAt: number;
  finishedAt?: number;
  started: boolean;
  finished: boolean;
}
```

职责：

- `updateAssistant(text, thinking)`：记录最新 assistant 文本和完整思考快照；
- `finishAssistant(text, isError)`：记录定稿文本和错误状态；
- `addTool()`：按开始时间记录工具，skill read 也在这里识别；
- `completeTool()`：只记录结果，不决定何时发送；
- `startNextTool()` / `finishActiveTool()`：维护 `activeTool` 和串行工具队列；
- `snapshot()`：选择当前思考、当前文本和最近工具；
- `diagnostics()`：提供日志字段。

`RunTimeline` 不知道 writer 是否死亡。工具推进、结果记录和快照始终可用。

### 4.2 工具状态与发送解耦

`onToolStart()` / `onToolEnd()` 不再因为 `writer.dead` 提前返回。它们只更新 `RunTimeline`，然后调用 `advanceTools()`：

```ts
private advanceTools(run: RunState): void {
  const relayTools = this.policy().relayTools;
  for (;;) {
    const active = run.timeline.active;
    if (active) {
      if (!active.result) return;
      if (!run.writer.dead && relayTools && !active.skillName) {
        run.writer.pushToolResult(...);
      }
      run.timeline.finishActiveTool();
      if (!this.hasPendingTools(run)) this.flushDeferred(run);
      continue;
    }
    const tool = run.timeline.startNextTool();
    if (!tool) return;
    if (!run.writer.dead && relayTools) {
      if (tool.skillName) run.writer.pushSkill(tool.skillName);
      else run.writer.pushTool(tool.name, tool.args);
    }
    if (!tool.result) return;
  }
}
```

这样即使 writer 在长时间工具期间熔断，`/last` 仍能知道当前工具和最近完成的工具。

### 4.3 快照选择

`RunTimeline.snapshot()` 的选择规则：

1. `run.timeline.currentThinking`（非空时）；
2. 工具块：
   - 当前 active 工具；
   - 最近 3 个已完成工具；
   - 按开始时间排序，最多 5 个；
   - 已完成工具带结果；未完成工具只带启动行；
   - skill read 使用 skill 块，不附带结果。
3. `run.timeline.currentText`（非空时）。

顺序固定为“思考 → 工具 → 文本”。这是状态快照，不保证与原始流的逐块交错顺序完全一致。

如果快照为空，`repushCurrent()` 返回 `{ ok: false, reason: "empty" }`，命令层回复提示，而不是静默。

### 4.4 `BubbleWriter.restartSnapshot()`

`BubbleWriter` 新增结构化重推接口：

```ts
export interface RepushTool {
  name: string;
  args?: unknown;
  skillName?: string;
  result?: { isError: boolean; result?: unknown };
}

export type RepushBlock =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: RepushTool }
  | { kind: "text"; text: string };

restartSnapshot(blocks: RepushBlock[], target?: { openid: string; msgId: string }): void;
```

实现步骤：

1. 入队，与现有 writer 操作串行；
2. 如果存在未关闭的 fenced code block，先关闭；
3. 如果当前有流，先 `rotateStream()` 结束旧气泡；
4. 更新 `openid` / `msgId`；
5. 重置 `streamDead`、`pendingResume`、`resumeAttempts`、`lastKind`、`toolOpen`、`fenceOpen` 等状态；
6. 按顺序调用 `pushThinking()`、`pushTool()` / `pushToolResult()` / `pushSkill()`、`pushText()`。

`restartText()` 保留为只含文本块的薄封装，供 `simple` 模式和现有测试使用。

### 4.5 `repushCurrent()` 返回值

```ts
type RepushResult =
  | { ok: true; thinkingLength: number; toolCount: number; textLength: number }
  | { ok: false; reason: "no-run" | "empty" };
```

行为：

- `replyType = "full"`：构建完整快照；
- `replyType = "simple"`：只构建文本快照；
- 无 run：返回 `no-run`；
- 快照为空：返回 `empty`。

推送成功后：

```ts
run.openid = openid;
run.msgId = msgId;
run.writer.restartSnapshot(blocks, { openid, msgId });
run.deferredThinking = "";
run.deferredText = "";
```

清空 deferred 是因为 `currentThinking` / `currentText` 已包含这些内容，避免后续 `flushDeferred()` 重复发送。

不要修改 `thinkingSentLen` / `resultSentLen`：它们记录原始流的处理进度。writer 死亡期间也要继续推进这些基准，这样重推后只发送新增内容。

### 4.6 重推后的继续输出

- 当前 `activeTool` 的启动行已在快照中；它结束时，`finishActiveTool()` 后把结果推送到新流；
- 已完成的工具已在快照中带结果，后续不会重复推送；
- 新工具通过正常 `onToolStart()` / `advanceTools()` 写入新流；
- 当前 assistant 文本已在快照中，后续 `onAssistantDelta()` 只推送新增文本；
- 如果 writer 再次熔断，可以再次执行 `/last`，每次都会创建新流和新 `msg_seq`。

### 4.7 命令层

`InboundCommandExtras.restartPush` 返回 `RepushResult`。`/last` 忙碌分支：

```ts
const result = extras.restartPush?.();
if (result && !result.ok) {
  await reply(t("commands.last.empty"));
}
```

新增 i18n：

```text
commands.last.empty
  中文：当前没有可重推的内容，任务仍在执行中。
  英文：Nothing to repush yet; the task is still running.
```

成功时不再额外回复，快照本身就是响应。

## 5. `replyType` 精简

`replyType` 只保留：

| 模式     | 行为                                   |
| -------- | -------------------------------------- |
| `full`   | 思考、工具、文本；`/last` 推送完整快照 |
| `simple` | assistant 文本；`/last` 只推送当前文本 |

`"last"` 已从类型、解析、策略、测试和文档移除。旧配置中的 `"last"` 会被解析为无效值，回退到 `full` 并给出配置告警。

## 6. 行为矩阵

| `replyType` | run 进行中 `/last`                 | 无内容时                   | run 已结束 `/last`            |
| ----------- | ---------------------------------- | -------------------------- | ----------------------------- |
| `full`      | 重推当前思考 + 最近工具 + 当前文本 | 回复 `commands.last.empty` | 重推最近完成的 assistant 文本 |
| `simple`    | 只重推当前文本                     | 回复 `commands.last.empty` | 重推最近完成的 assistant 文本 |

## 7. 实施文件

| 文件                              | 变更                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `src/relay/run-timeline.ts` (new) | `RunTimeline`、`TimelineTool`、快照选择和工具状态                                   |
| `src/relay/run-stream-relay.ts`   | 使用 `RunTimeline`；`advanceTools()`；`RepushResult`；移除 last 模式与 fallback     |
| `src/relay/bubble-writer.ts`      | `RepushBlock`、`restartSnapshot()`、状态复位                                        |
| `src/relay/reply-policy.ts`       | 移除 `relayTextLive`、`deliverLastAtEnd` 和 last 策略                               |
| `src/infra/reply-type.ts`         | 仅保留 `full` / `simple`                                                            |
| `src/qq/inbound-command.ts`       | `/last` 处理 `RepushResult`；移除 last 模式提示                                     |
| `src/qq/qq-message-handler.ts`    | 透传 `repushCurrent` 结果；移除 `getReplyType` 依赖                                 |
| `src/infra/i18n.ts`               | 增加 `commands.last.empty`；移除 `commands.last.running`；更新 `settings.replyType` |
| `index.ts`                        | 移除 `onFallbackReply` 和 inbound 的 `getReplyType` 依赖                            |

## 8. 测试

`test/relay/run-stream-relay.test.ts` 新增/覆盖：

- full 模式只有思考时，`/last` 重推思考块；
- full 模式只有工具时，`/last` 重推工具启动行；
- 重推后的当前工具结果继续写入新流；
- writer 死亡后，`/last` 恢复新流；
- writer 死亡期间仍记录工具，并可重推；
- 快照只包含最近的工具；
- simple 模式无文本时返回 `empty`；
- 原有思考/工具/文本顺序、12k 切泡、并行工具、skill、错误恢复测试保持通过。

命令测试覆盖：

- 忙碌时调用 `restartPush()`；
- `empty` 时回复 `commands.last.empty`；
- 成功时不额外回复。

配置测试覆盖：

- `"last"` 被拒绝并回退到 `full`。

## 9. 风险与边界

| 风险                            | 影响                   | 处理                                              |
| ------------------------------- | ---------------------- | ------------------------------------------------- |
| 快照顺序与原始交错不同          | 重推内容不是完整时间线 | 明确为“当前状态快照”                              |
| 工具窗口有限                    | 更早的工具不会重推     | 当前工具 + 最近 3 个已完成工具                    |
| 思考/文本过长                   | 新气泡可能被拆分       | 复用现有 12k 拆分逻辑                             |
| `/last` 重复执行                | 每次都会新建气泡       | 手动操作，允许重复                                |
| `msgseq` 碰撞仍可能再次熔断     | 恢复后仍可能中断       | 单独修复 `40054005`；不在本方案范围               |
| writer 死亡期间工具状态继续增长 | 内存增加               | 快照有界；`run.tools` 仅在单个 run 生命周期内增长 |

## 10. 验收标准

- full 模式下，run 进行中 `/last` 在无 assistant 文本时也能立即产生新的流式气泡。
- 气泡内容至少包含当前思考或当前工具；有文本时同时包含文本。
- writer 已 `dead` 时，`/last` 能打开新流并继续后续输出。
- 重推后不重复发送旧文本/旧思考。
- simple 模式行为保持文本重推。
- 空快照有明确提示，不再静默。
- `npm run lint`、`npm run typecheck`、`npm test`、`npm run format:check` 通过。
