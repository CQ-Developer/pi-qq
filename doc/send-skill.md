# QQ 侧 Skill 执行显示调研

> 状态：调研/设计文档，尚未实现
> 日期：2026-11-04
> 涉及版本：pi-qq 1.3.4，pi 1.5.0
> 证据截图：
>
> - pi TUI：`/home/chen/project/pi-qq-test/pi.png`
> - QQ：`/home/chen/project/pi-qq-test/qq.jpg`

## 1. 问题

在 pi TUI 中，skill 执行会显示为独立的 `[skill]` 段，例如：

```text
[skill] playwright-cli (ctrl+o to expand)
```

但在 QQ 侧看不到对应的 skill 段，用户无法判断：

- 当前是否加载了 skill；
- 加载的是哪个 skill；
- skill 是自动选择还是显式调用；
- skill 的执行是否已经开始。

### 结论

截图中的 `[skill]` 是 pi TUI 对 **读取 `SKILL.md` 的 read 工具** 的特殊渲染，不是独立的 skill 事件。QQ 目前把同一操作显示成普通 `read` 工具，所以缺少 `[skill]` 语义段；如果用户是从 QQ 或 TUI 显式执行 `/skill:name`，还存在命令路由和 user message 转发两个独立问题。

## 2. 现象与证据

### 2.1 pi TUI

`pi.png` 中可以看到：

```text
[skill] playwright-cli (ctrl+o to expand)
Let me render it and take a screenshot to verify the layout.
$ cd /home/chen/project/pi-qq-test && (playwright-cli --version ...)
```

`[skill]` 是折叠状态，按 `ctrl+o` 可以展开查看完整内容。

### 2.2 QQ

`qq.jpg` 中可以看到：

- `📖 read` 工具气泡；
- 参数是 `/home/chen/.pi/agent/skills/playwright-cli/SKILL.md`；
- 工具结果中显示了 `SKILL.md` 的全文；
- 之后是“思考”和 `bash` 气泡。

因此，**QQ 并不是完全没有收到 skill 内容**；它收到的是“read 了 SKILL.md”的普通工具调用，缺少的是 pi TUI 中的 **`[skill] playwright-cli` 语义段**。

### 2.3 会话记录

对应会话：

```text
/home/chen/.pi/agent/sessions/--home-chen-project-pi-qq-test--/
  2026-11-03T15-37-34-742Z_01a1a20f-0115-7773-a4c5-a011cda00d57.jsonl
```

关键记录：

- entry 15：assistant 发起两个 tool call：
  - `bash`：验证 HTML；
  - `read`：`/home/chen/.pi/agent/skills/playwright-cli/SKILL.md`
- entry 17：`read` 的 toolResult，内容是完整 `SKILL.md`；
- entry 18：assistant 继续输出“Let me render it...”并调用 `playwright-cli`。

这个会话里 **没有** `/skill:playwright-cli` 的用户消息，也没有独立的 skill 事件；只有一次普通的 `read` 工具调用。

## 3. pi 中 skill 的两条展示路径

pi 的 skill 展示不是一个统一的 `skill_start` 事件，而是两条不同的展示路径。

### 3.1 模型自动读取 `SKILL.md`

当模型决定使用某个 skill 时，常见行为是调用 `read` 读取：

```text
/home/chen/.pi/agent/skills/<name>/SKILL.md
```

pi 的 read 工具渲染器会对 `SKILL.md` 做特殊分类：

```ts
// pi: dist/core/tools/renderers/read.js
if (fileName === "SKILL.md") {
  return { kind: "skill", label: basename(dirname(absolutePath)) };
}
```

然后折叠显示为：

```text
[skill] <name> (ctrl+o to expand)
```

这解释了两个现象：

- pi TUI 看到的是 `[skill]`；
- 会话里实际只有 `read` 工具调用，没有独立 skill 事件。

### 3.2 用户显式执行 `/skill:<name>`

pi 支持显式命令：

```text
/skill:playwright-cli
```

`AgentSession.expandSkillCommand()` 会把命令展开为一条 **user message**，内容类似：

```text
<skill name="playwright-cli" location="/.../SKILL.md">
References are relative to /...。
...
</skill>
```

TUI 用 `parseSkillBlock()` 解析这条 user message，并渲染 `SkillInvocationMessageComponent`，也就是独立的 `[skill]` 卡片。

这条路径的 skill 段是 **user message**，不是 tool call。

## 4. pi-qq 当前的处理路径

### 4.1 自动读取路径

模型读取 `SKILL.md` 时，pi-qq 收到的是普通 `tool_execution_start/end`：

- `toolName = "read"`
- `args.path = ".../SKILL.md"`

`src/relay/stream-block-format.ts` 的 `formatToolLine()` 只根据工具名和参数格式化：

```ts
formatToolLine("read", { path: "/.../SKILL.md" });
// 输出 **📖 read** + 路径
```

`src/relay/bubble-writer.ts` 把它当作普通 read 工具气泡，结果也按普通 tool result 输出。因此：

- QQ 能看到路径和 `SKILL.md` 全文；
- 但看不到 `[skill] playwright-cli` 这个语义段。

### 4.2 显式 `/skill:` 路径

pi-qq 的 QQ 入站处理在 `src/qq/qq-message-handler.ts` 中：

```ts
if (contentText.startsWith("/")) {
  const command = contentText.split(/\s+/)[0];
  await handleInboundCommand(contentText, reply, deps, ...);
  return;
}
```

所有以 `/` 开头的文本都进入命令路由。`src/qq/inbound-command.ts` 只识别 `/help`、`/stop`、`/compact`、`/status`、`/last`、`/new`；`/skill:playwright-cli` 会落入：

```text
Unknown command /skill:playwright-cli; use /help.
```

也就是说，**QQ 侧目前无法显式触发 `/skill:` 命令**。

即使从 TUI 显式执行 `/skill:name`，pi-qq 的 `message_end` 处理器也会过滤掉非 assistant 消息：

```ts
if (msg.role !== "assistant" || !running) return;
```

`message_update` 同样只处理 assistant 消息。因此：

- skill 的 user message 段不会被转发到 QQ；
- 只有后续 assistant 输出或 tool call 才会显示。

## 5. 问题原因

### 5.1 自动路径的原因

pi 的 `[skill]` 只是 **read 渲染器的展示分类**，不是协议事件：

- 没有 `skill_start` / `skill_end` 事件；
- pi-qq 只能通过 `read` 参数中的 `SKILL.md` 路径推断；
- 当前 `formatToolLine()` 没有这个推断，所以显示成普通 `read`。

### 5.2 显式路径的原因

- QQ 命令路由把所有 `/...` 当内置命令，`/skill:` 没有对应分支；
- pi-qq 不转发 user message，因此即使从 TUI 触发，QQ 也看不到 `[skill]` 段；
- 没有调用 `sendUserMessage(..., { expandPromptTemplates: true })`，所以 QQ 触发的 skill 也无法被 pi 展开。

### 5.3 不是 skill 内容缺失

截图和会话证明，自动路径中 `SKILL.md` 的内容实际上已经通过 read 工具到达 QQ。用户感知到的“没有显示”，是缺少“这是一个 skill”的语义标签，而不是缺少文件内容。

如果用户实际遇到的是“显式 `/skill:` 完全没有显示”，则同时存在命令路由和 user message 转发两个问题。

## 6. 解决方案

### 6.1 自动路径：识别 `SKILL.md` read

新增纯函数：

```ts
export interface SkillReadInfo {
  name: string;
  path: string;
}

export function detectSkillRead(toolName: string, args: unknown): SkillReadInfo | undefined;
```

规则：

- `toolName === "read"`；
- 参数路径的 basename 为 `SKILL.md`；
- skill 名称取父目录名，例如：
  - `~/.pi/agent/skills/playwright-cli/SKILL.md` → `playwright-cli`；
  - 项目 `.agents/skills/my-skill/SKILL.md` → `my-skill`。

在 `RunFeedback.startNextTool()` 或 `BubbleWriter.pushTool()` 中使用该信息，输出单独的 skill 气泡：

```text
🧩 Skill: playwright-cli
```

服务端仍需保留 read 结果，或者按下面的展示策略处理。

### 6.2 显式路径：支持 QQ `/skill:`

在 `handleInboundCommand()` 的 `/` 路由中增加：

```ts
if (cmd.startsWith("/skill:")) {
  // 不要把 /skill: 当普通命令
  deps.sendToPi(text, { expandPromptTemplates: true });
  deps.markQQTrigger(...);
  return;
}
```

实际实现更建议在 `qq-message-handler` 的命令分支前判断：

- `/skill:` 不进入普通命令路由；
- 调用 `pi.sendUserMessage(text, { expandPromptTemplates: true })`；
- 同时 `markQQTrigger(openid, msgId)`，保证后续 assistant/tool 输出回传 QQ。

需要新增依赖端口，例如：

```ts
sendToPi: (text: string, options?: { expandPromptTemplates?: boolean }) => void;
markQQTrigger: (openid: string, msgId: string) => void;
```

### 6.3 显式路径：转发 skill user message

如果希望从 TUI 触发的 `/skill:` 也显示在 QQ，需要在 `index.ts` 的 `message_start` / `message_end` 中处理 user message：

- 用 `parseSkillBlock()` 判断是否包含 `<skill ...>`；
- 提取 `name`、`location`、`userMessage`；
- 以 `🧩 Skill: <name>` 气泡回传；
- 只回传 skill 元信息，不回传完整 skill 内容，避免刷屏；
- 如果有 `userMessage`，可以单独显示用户请求。

注意：

- QQ 用户消息本来不应该全部回显，只有 skill 块需要特殊处理；
- 需要避免和自动 read 路径重复显示（例如模型先读 SKILL.md，又有 skill user message）。

### 6.4 展示策略

可选：

1. **只加 skill 标签，保留 read 全文**：信息最全，但 QQ 上会出现很长的 SKILL.md 内容；
2. **只显示 `🧩 Skill: name`，隐藏 read 结果**：接近 pi 折叠视图，但用户无法查看 skill 内容；
3. **显示 `🧩 Skill: name` + 路径 + 截断摘要**：推荐；既表明 skill，又避免刷屏；
4. **单独提供 `/skill:name` 触发**，不依赖模型自动读取。

建议第一版：

- 自动路径检测到 `SKILL.md` read 时，把工具标题替换为 `🧩 Skill: <name>`；
- read 结果保留但限制长度（例如 8 行/600 字符，复用现有 `formatToolResult` 截断）；
- 显式路径先支持 QQ `/skill:` 调用，不急着转发 TUI 的 user message；
- 后续再决定是否把 user message skill 卡也转发。

### 6.5 图标与文案

- 图标：`🧩`（skill）；
- 英文：`🧩 Skill: playwright-cli`
- 中文：`🧩 技能：playwright-cli`
- 需要加入 i18n 字典，并复用 `language` 配置。

## 7. 执行计划

### Phase 1：自动路径识别

1. 新增 `detectSkillRead()` 和路径解析测试；
2. 在 `formatToolLine()` / `BubbleWriter` 中接入 skill 标签；
3. 保留 read 结果，但使用现有截断逻辑；
4. 测试：
   - `SKILL.md` 正常识别；
   - 普通 `read` 不受影响；
   - Windows/Unix 路径；
   - 项目 `.agents/skills` 和全局 `~/.pi/agent/skills`。

### Phase 2：显式 QQ `/skill:`

1. 在入站命令路由中放行 `/skill:`；
2. 通过 `pi.sendUserMessage(..., { expandPromptTemplates: true })` 触发；
3. 标记 QQ trigger，确保 assistant/tool 输出回传；
4. 测试未知命令、普通命令、`/skill:` 三种分支。

### Phase 3：TUI skill user message（可选）

1. 在 `message_start` / `message_end` 中识别 user 消息的 `<skill ...>`；
2. `parseSkillBlock()` 提取 name/location/userMessage；
3. 以 skill 气泡转发；
4. 去重：同一 run 中自动 read 和 user message 只显示一次。

### Phase 4：文档与验证

1. 更新 README 的 skill 行为说明；
2. 增加 `CHANGELOG`；
3. 用 `pi-qq-test` 截图对比：
   - pi TUI `[skill]`；
   - QQ `🧩 Skill: ...`；
   - 长 SKILL.md 截断；
   - 中英文显示。

## 8. 待确认问题

1. 用户看到的“没有显示”具体是：
   - 只有自动 read 时缺少 `[skill]` 标签；
   - 还是显式 `/skill:` 完全无反应；
   - 还是两者都有。
2. QQ 是否需要显示完整 `SKILL.md` 内容，还是只显示 skill 名称/摘要。
3. 是否允许从 QQ 直接执行 `/skill:name`；如果允许，是否需要 allowlist/权限控制。
4. 是否要把 TUI 中显式 `/skill:` 的 user message 同步到 QQ。
5. skill 名称是否需要显示来源（全局/项目）。
