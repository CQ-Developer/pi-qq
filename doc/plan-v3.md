# pi-qq — plan-v3.md

> 执行计划。功能范围见 [features-v3.md](./features-v3.md)；本文只回答：改哪些文件、按什么顺序做、每步怎么验收。
> V3 范围：F12 直推式过程回传、F13 移除消息心跳、F14 配置项收敛。无新增依赖。

## 0. 前置与范围

- 基线：v2 代码；工作区已移除消息心跳（F13，未提交）。
- 沿用：`AppendStream` 的 append 语义、500ms 节流、限流退避；`ReplyBudget`、typing 保鲜、消息路径降级。
- 本计划不实现：工具耗时、思考脱敏/折叠、用量摘要、时间线持久化。
- 发布门槛（真机验证）：平台是否接受同泡续写、同 `msgId` 下大量按块新建气泡、现有气泡的 5 分钟限制、流式 Markdown 渲染、单块长度/帧数上限。
- 若验证失败：续写改为新建气泡；`streamRelay` / `markdownSupport` 删除失败则只回滚对应项，其余改动可独立保留。

## 1. 模块改动

| 文件                         | 改动                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/run-feedback.ts`        | 重写为直推：删除窗口/`flushTimer`/气泡 kind；思考差量与引用块；工具参数/结果；按内容块切泡，单块 >12k 安全边界切泡；续写/重建 + `streamDead` 熔断 |
| `src/append-stream.ts`       | 新增 `flush()`（发送并等待缓冲确认）；按 M6-0 结果实现 `checkpoint()` / 同泡续写，或保持新建气泡                                                  |
| `src/config.ts`              | 删除 `streamFlushMs`、`streamAssistant`、`streamRelay`、`markdownSupport`；新增 `thinkingRelay`（默认 `true`）                                    |
| `index.ts`                   | 删除 `getStreamFlushMs`、`getStreamRelay`、`markdownSupport` 传参与分支；新增 `getThinkingRelay`；`tool_execution_*` 传入 args/result             |
| `src/bot.ts`                 | 删除 `markdownSupport` 选项；`QQBot` 不再传该参数，`sendText` 固定纯文本                                                                          |
| `test/run-feedback.test.ts`  | 重写：直推顺序、思考差量、工具参数/结果、截断、续写/重建、熔断、`thinkingRelay:false`、按块切泡、12k 切泡与围栏                                   |
| `test/append-stream.test.ts` | 补 `flush()`、`checkpoint()` / 续写（若验证通过）与失败路径测试                                                                                   |
| `test/outbound.test.ts`      | 删除 `streamFlushMs` 断言                                                                                                                         |
| `README.md` / `README-zh.md` | 配置表：删除五个键、新增 `thinkingRelay`；更新长任务描述                                                                                          |
| `doc/features-v1.md`         | F7 标注由 v3 取代；配置表按 v3 调整                                                                                                               |
| `doc/features-v3.md`         | 按实现结果校正状态、工具格式与实测记录                                                                                                            |

## 2. 执行步骤

### M6-0 — 平台续写能力验证（先行）

目标：确定失败后能否在**同一气泡**续写；结果决定 M6-2 的实现分支。

**探针**

1. 已扩展 `/qq-test-stream resume`（`index.ts`）：
   - 建流发送 frame 1，调用 `AppendStream.flush()` 拿到 `stream_msg_id` / `msg_seq` / 下一个 `index`；
   - 不发送 DONE，`dispose()` 丢弃客户端 stream；
   - 800ms 后用相同标识 + 下一个 `index` 新建 `AppendStream`，发送 frame 2 与 DONE；
   - 在 QQ 端确认是否仍落在同一气泡。
2. 已加 `AppendStream.flush()` / `checkpoint()` / `resume` 选项与单测（`test/append-stream.test.ts`）。
3. 依次验证：
   - clean resume（`/qq-test-stream resume`）；
   - 失败后续写（真实 run 中断网 / 构造一次 429 以外的错误后重试）；
   - `index` 跳号与重复 index 的平台行为；
   - 入站消息超过 5 分钟后是否仍可续写；
   - 续写后 DONE 是否正常收尾。
4. 记录结果到 `features-v3.md` §2.4 / §5。

**运行方式**

1. 重新加载 pi-qq 扩展（或重启 pi）。
2. 在 QQ 上发一条命令（如 `/help`），确保 `budget.lastTarget` 有 `msgId` 且不启动 run。
3. 在 pi 终端执行 `/qq-test-stream resume`。
4. 看 QQ：frame 1 与 frame 2 是否在同一气泡；命令会提示 `stream_msg_id` 与下一个 `index`。

**结果（已实测）**

- frame 1 后丢弃客户端对象，等 800ms，用同一 `stream_msg_id` + `index=1` 发送 frame 2 与 DONE。
- QQ 端两帧在**同一气泡**；终端拿到 `stream_msg_id`，说明 clean resume 可用。

**分支**

- 采用同泡续写：M6-2 实现检查点 + 最多 2 次续写，失败后 `streamDead`。
- 新建气泡保留为回退方案：若后续实测失败后续写不可用，再切换到新建气泡（最多 1 次）。

**验证**

- clean resume 结果可复现。
- 失败后续写、`index` 跳号/重复、5 分钟后行为仍需真实故障验证。
- 结论写入文档后再进入 M6-2。

### M6-1 — F13 收尾与基线确认

**改动**

- 核对已完成的删除项：`heartbeatTimer`、`beat()`、`formatHeartbeat`、`messageHeartbeats`、`RunState.tools`、`onToolEnd`（心跳版）、`getHeartbeatMinutes`、`getHeartbeatMaxMessages`、配置默认值、README/features 文案、单测。
- 确认旧配置键（`heartbeatMinutes`、`heartbeatMaxMessages`）被静默忽略。

**验证**

- `grep -ri "heartbeat" src test index.ts README*.md doc/features-v1.md` 无结果（历史 plan 文档除外）。
- `npm run typecheck && npm test && npm run lint && npm run format:check` 全绿。

### M6-2 — RunFeedback 直推重写

**改动**

1. 删除：`winLines`、`flushTimer`、`collectWindowLines`、`appendLineGroups`、`appendText`、`startNewBubble`、`Bubble.kind` 等窗口与切泡逻辑；保留单一 append 串行链；新增按内容块主动新建气泡。
2. 新状态：
   - `thinkingSentLen`（逐消息差量基准，`message_end` 重置）；
   - `lastKind: "none" | "thinking" | "tool" | "text"`（块间空行）；
   - `msgIdAt`（入站触发时间，用于续写/重建 TTL）；
   - 续写/重建计数（同泡最多 2 次，或新建气泡最多 1 次，按 M6-0 结论）；
   - `streamDead`（续写/重建失败/过期后熔断）；
   - 文本沿用 `finalizedText` / `snapshotText` / `resultSentLen`。
3. 格式化辅助（放 `src/run-feedback.ts`，可导出供测试）：
   - `formatToolLine(name, args)`：主参数提取（字符串直接使用；对象按 `command` → `path` / `file_path` / `filename` → `pattern` / `query` / `url`；否则紧凑 JSON），截断 200 字符，用反引号包裹（内含反引号时改用双反引号）；
   - `formatToolResult(result, isError)`：生成 `text` 代码块；失败首行 `❌ `；结果截断 600 字符 / 8 行；空结果 `(no output)`；围栏长度按内容动态选择。
4. `onAssistantDelta(snapshotText, snapshotThinking)`：
   - `thinkingRelay` 为真时先追加 thinking 差量（每行 `> `，空行 `>`）；
   - 再追加 text 差量（原文）；
   - 差量基准只在 append 成功后推进。
5. `onToolStart(name, args, toolCallId)`：追加 `**<name>**`、空行、`` `<主参数>` ``，每个工具单独成泡。
6. `onToolEnd(name, isError, result)`：追加结果行；失败直接输出错误结果，无额外标记。
7. `onAssistantFinal(text, isError)`：
   - 调用 `AppendStream.flush()` 确认当前缓冲；
   - 若 flush 失败或 `streamDead` → 返回 `false`，由消息路径发送该消息完整文本；
   - 否则返回 `true`；
   - 重置 `thinkingSentLen`，不封泡；块切换时由下一次事件新建气泡。
8. `onAgentEnd()`：flush 剩余内容 + DONE；清理 typing 定时器。
9. 失败与续写（clean resume 已通过）：
   - 保存检查点（`stream_msg_id` / `msg_seq` / 下一个 `index` / 未确认缓冲），失败后用同一 `stream_msg_id` 与下一个 `index` 重发；
   - `AppendStream.index` 每次发送尝试后递增（平台要求递增），失败帧的缓冲随下一个 index 重发；
   - 最多 2 次续写；仍失败 → `streamDead = true`，`onWarn` 只提示一次；
   - 若后续实测同泡续写不可用，回退新建气泡（最多 1 次）；
   - `streamDead` 后不再建泡，所有后续消息走消息路径；
   - 已确认显示的内容不补发；失败帧的未确认缓冲随续写重发（可能重复）；最终文本以 `message_end` 的完整文本为准。
10. 排版：块切换补一个空行；连续工具段不空行；思考行前缀 `> `。

**测试**

- 按块切泡：思考块、每个工具调用、文本块各一个 DONE；并行工具按开始顺序逐个成泡；单个块 >12k 时按安全边界继续切。
- 顺序：thinking → tool（参数）→ result → text → thinking → tool → result → text 与调用顺序一致。
- 差量：同一 thinking 快照多次更新不重复；文本快照多次更新不重复。
- 工具：主参数提取与反引号包裹、成功/失败代码块、围栏自适配（结果内含 ```）、截断上限、空结果。
- 续写：clean resume 后同一气泡继续；失败帧同 index 重试；再次失败后 `streamDead`，后续事件不再调用流 API。
- 最终文本：`streamDead` 时 `onAssistantFinal` 返回 `false`，消息路径发送完整文本；不重复发送「未发送片段」。
- `thinkingRelay: false`：无思考输出，工具/文本不受影响。
- QQ 未触发 run：所有事件静默。

**验证**

- `npm test` 全绿；`npm run typecheck` 通过。
- 人工检查生成的帧内容与 `features-v3.md` §2.2 样例一致。

### M6-3 — 配置收敛

**改动**

1. `src/config.ts`：
   - 删除 `streamFlushMs`、`streamAssistant`、`streamRelay`、`markdownSupport` 字段与默认值；
   - 新增 `thinkingRelay?: boolean`，默认 `true`。
2. `index.ts`：
   - 删除 `getStreamFlushMs`、`getStreamRelay`、`markdownSupport` 传参与日志字段；
   - 新增 `getThinkingRelay`；
   - 消息路径固定 `markdownToPlain(text)`，不再按配置分支。
3. `src/bot.ts`：`StartBotOptions` 删除 `markdownSupport`；`QQBot` 不再传该参数（默认 false，`sendText` 纯文本）。
4. `src/run-feedback.ts`：依赖改为 `getThinkingRelay`，删除流开关判断。
5. 文档：README 中英文配置表、`features-v1.md` §4、`features-v3.md` §4。
6. 旧配置键静默忽略，不迁移、不写回；发布说明提示 `streamRelay: false` / `markdownSupport: true` 用户行为变化。

**验证**

- `getSettings({}).thinkingRelay === true`；`getSettings({ thinkingRelay: false }).thinkingRelay === false`。
- `getSettings({}).streamRelay === undefined`、`.streamFlushMs === undefined`、`.streamAssistant === undefined`、`.markdownSupport === undefined`。
- 旧配置文件（含五个已删键）启动无报错。

### M6-4 — 真机验收

**场景**

1. 短任务（1 次工具）：逐项比对输出格式：思考引用块、`**bash**` + 空行 + `` `<命令>` ``、`text` 结果块。
2. 长任务（>10 分钟、多轮工具）：每个内容块一个泡；每个工具调用一个泡，并行工具按开始顺序逐个展示；单块 >12k 时按安全边界继续切；顺序正确、无汇总延迟、无重复、无心跳消息；切点处围栏闭合、工具参数与结果不拆开。
3. 工具失败：构造错误命令，确认结果代码块首行 `❌ ` 可见，无额外标记行。
4. 续写：按 M6-0 结论验证同泡续写；不支持时验证新建气泡；再次失败后停止推送，最终文本完整送达，warn 一次。
5. `msgId` 超过 5 分钟：观察现有气泡是否仍可追加、续写/重建是否被拒，记录结论。
6. `thinkingRelay: false`：无思考内容，工具/文本正常。
7. 流式 Markdown：确认引用块、`**bash**` + 空行 + `` `<命令>` ``、结果代码块渲染正常；不渲染则回滚 `streamRelay` / `markdownSupport` 删除。
8. 回退纯文本：构造 `streamDead`，确认最终消息无 Markdown 记号残留。
9. 额度：`/qq-test-budget` 观察气泡数、续写/重建次数、主动消息消耗。
10. 并行工具：确认结果代码块归属是否可读；必要时记录后续改进。
11. 超长块：构造 >12k 字符的单个思考/文本块，确认块内主动切泡、多泡连续、无内容丢失/重复，并记录新泡的 `stream_msg_id` 与平台行为。

### M6-5 — 文档与发布

- `features-v3.md` 状态改为已实现，更新待确认项结论与实测记录。
- `plan-v3.md` 勾选 Todo、补充执行记录。
- README 中英文同步；版本号按发布流程调整。
- 发布说明写明：心跳删除、`streamRelay`/`streamFlushMs`/`streamAssistant`/`markdownSupport` 删除、`thinkingRelay` 新增。

## 3. Todo-List

- [x] M6-0 续写探针（`/qq-test-stream resume` + `flush()`/`checkpoint()` + 单测）
- [x] M6-0 clean resume 真机验证：同一气泡，`stream_msg_id` + `index=1` 成功
- [ ] M6-0 失败后续写 / index 跳号重复 / 5 分钟后行为（真实故障时验证）
- [x] F13 收尾：基线全绿、旧配置键忽略
- [x] `AppendStream.flush()`：发送并等待缓冲确认
- [x] `AppendStream` index 每次尝试递增，检查点携带未确认缓冲
- [x] 按 clean resume 结论实现同泡续写（最多 2 次）
- [x] `RunFeedback` 按内容块切泡：思考、每个工具调用、文本各自成泡；单块 >12k 安全边界切泡
- [x] 围栏跟踪：块切换补闭合围栏（思考内保留 `> `），切泡条件要求围栏闭合
- [x] 按块切泡、工具/结果不拆泡、并行工具按 toolCallId 归属、工具期间思考延后、abort 丢弃排队输出的单测：`npm test` 133 passed
- [x] thinking 差量 + 引用块 + `thinkingRelay`
- [x] 工具 `**<name>**` + 空行 + `` `<主参数>` `` 与结果代码块、失败 `❌ `、围栏自适配；每个工具独立成泡
- [x] `streamDead` 熔断 + 单次 warn
- [x] `message_end` 接管判定：dead/flush 失败 → 完整文本走消息路径
- [x] 删除 `streamRelay`、`streamFlushMs`、`streamAssistant`、`markdownSupport`；新增 `thinkingRelay`
- [x] `bot.ts` 去掉 `markdownSupport`，消息路径固定纯文本
- [x] 重写 `test/run-feedback.test.ts`；补 `test/append-stream.test.ts`；清理 `test/outbound.test.ts`
- [x] README 中英文与 `features-v1.md` 同步
- [ ] 真机验收剩余项：多轮/长任务、按块多泡复验（单行引用修复、工具格式/逐工具成泡）、失败续写、5 分钟后续写、`thinkingRelay: false`、纯文本回退、额度、并行工具、超长块切泡
- [x] 真机主链路复验：单泡、工具成功/失败、最终 Markdown（2026-11-02）
- [ ] `features-v3.md` 校正为最终实现

## 4. 整体验证标准

- `npm run typecheck`、`npm run lint`、`npm test`、`npm run format:check` 全部通过。
- 单测覆盖：按块切泡、事件顺序、思考去重与开关、工具参数/结果/截断、工具格式、顺序/并行工具归属、续写/重建、熔断、最终文本接管、12k 切泡、围栏补闭合、工具与结果不拆泡。
- 真机：短任务与长任务均无汇总消息、无心跳；工具参数/结果可读；失败时最终文本必达；回退为纯文本。
- 配置面：`~/.pi/agent/pi-qq.json` 仅保留 `features-v3.md` §4 列出的键；旧键无害。

## 5. 风险与回滚

- **`streamRelay` / `markdownSupport` 删除**：无手动关停；若真机发现流式不可用/不渲染，回滚对应项（恢复配置与判断），其余 F12/F13/F14 保留。
- **续写语义**：clean resume 已验证；失败帧是否已被平台确认未知，同 index 重试可能重复或丢一段；重复/跳号 index 行为待真实故障验证。
- **续写配额**：同泡续写不新增气泡；最终消息可能接近 `msgId` 的 4 条被动额度，超限时直接熔断。
- **单块超限**：平台在约 15k 字符后自动切分且切点不可控；单块内已改为 12k 安全边界切泡（行首、围栏闭合、无待续写、无进行中的工具），工具参数行与结果不拆开。若真机不接受同一 `msgId` 的新泡，回退为接受平台自动切分或调整阈值。
- **按块多泡**：每个内容块新建 stream，71k 实测 34 次工具调用会产生约 34 个顺序工具泡；若平台限制消息频率/被动额度或刷屏不可接受，回退为「过程泡 + 最终答复泡」。
- **单行引用块**：QQ 会把单行思考引用块显示为 `该消息类型暂不支持查看`；已在每个思考泡末尾补空引用行 `>`，需真机复验。
- **参数/结果刷屏**：优先收紧截断上限；仍不可接受时后续增加 `toolDetail` 级别（本计划不实现）。
- **平台拒绝**：`streamDead` 熔断保证本 run 不再重试；最终文本走消息路径。
- **`msgId` 过期**：记录实测；若现有气泡也受 5 分钟限制，需在超时前主动收尾或降级。
- **回滚**：`git revert` 本次发布提交；被删除的配置键在旧版本中按默认值处理，不需要数据迁移。

## 6. 执行记录

- 2026-11-02：F13 心跳移除；M6-0 clean resume 实测通过（同一气泡，`stream_msg_id` + `index=1`）；F12 直推、工具参数/结果、`thinkingRelay`、同泡续写/熔断、M6-3 配置收敛已实现；`npm test` 118 passed。
- 真机测试发现并修复：平台要求 `index` 每次递增（失败帧用下一个 index 重发）；工具结果需从 `content[].text` 提取，不能直接 JSON 序列化 wrapper。
- 2026-11-02：真机截图发现最终答案的空格与代码块换行丢失（如 `使用 uv管理`、结构树多行粘连）。根因是 `onAssistantDelta` 用 `delta.trim()` 丢弃纯空白差量，却已推进 `resultSentLen`；改为保留空白，并补纯空白、代码块换行、逐字符快照 3 个单测，`npm test` 121 passed；真机复验见下条。
- 2026-11-02：上一轮长任务累计约 15k 字符后平台自动切出第二泡（`stream_msg_id` 不变，切点可能落在块中间）；本轮 9.3k 字符未复现，超长切泡仍待验证。
- 2026-11-02：空白修复后真机复验（run 03:20:29–03:21:14）：最终答案与 `textPreview` 逐字一致（1381 字符）；单泡 35 帧（`index` 0–34，DONE 34），累计 9351 字符；无 warn/error；工具失败与截断显示正常。
- 2026-11-02：同一日志中 03:50:47 的第二个 run 被 abort，无输出；若为手动停止则正常。
- 2026-11-02：71k 字符长任务日志审阅：157 个 GENERATING 帧、累计 71,478 字符，单泡超过平台阈值后自动切分；11 帧起始处于未闭合 ``` 围栏内，截图确认工具行会被代码卡片吞入。据此实现 `MAX_BUBBLE_CHARS = 12_000`、围栏跟踪与块切换补闭合（思考内补 `> ` 前缀），并增加切泡 / 工具前切泡 / 工具与结果不拆泡 / 围栏补闭合 / 工具行内联反引号 / 空结果 wrapper 单测；`npm test` 127 passed，typecheck / lint / format 全绿。
- 2026-11-02：按需求改为「每个内容块一个气泡」：思考块、文本块各新建 stream；工具改为每个调用独立成泡，按开始顺序串行展示，结果按 `toolCallId` 归属；单块内仍保留 12k 安全切泡。工具行格式改为 `**<name>**` + 空行 + `` `<主参数>` ``。新增气泡边界、顺序工具各自成泡、同名并行工具归属、工具期间思考延后、abort 前发送已完成工具单测；`npm test` 133 passed。
- 2026-11-02：按块多泡真机测试（run 07:38:06–07:44:03Z）：30 个气泡、16 次工具、277 次 API 全部 200，无 warn/error；思考/工具/文本顺序正确，工具行与结果同泡，q1–q5 截图确认。发现第 7 个短思考泡显示 `该消息类型暂不支持查看`。
- 2026-11-02：同一 71k run 在启动后整 180s 报 `assistant message ended error` / `⚠️ Model error: terminated`（最后帧后约 11s），用户侧看到错误提示；非扩展流式帧错误（无 `stream error` / `请求参数index需要递增`），暂按模型侧流中断记录，待复现后确认。
- 2026-11-02：短 stream 诊断（`/qq-test-stream short`）确认：plain 11/48、中文短文本、短工具泡均正常；单行引用 `> quote short` 与 `> We need ...` 不支持；补空引用行 `> quote short\n>\n`、两行引用、`> We need ...\n>\n` 均正常。根因是单行引用块。实现：每个思考块结束（切换块或 agent_end）补 `>` 空引用行，再结束/切泡。`npm test` 130 passed；待真机复验。
- 2026-11-02：真机 `/stop` 后旧实现仍会发送排队中的工具泡（第二个/第三个工具在 Abort requested 之后出现）。实现 `beforeAbort()`：先处理已完成的工具（含排队结果），再标记 abort；未完成的后续思考/文本丢弃，然后发送 Abort requested。`npm test` 133 passed。
