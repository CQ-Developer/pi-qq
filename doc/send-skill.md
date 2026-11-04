# QQ 侧 Skill 执行显示设计

> 状态：设计文档，尚未实现
> 日期：2026-11-04
> 涉及版本：pi-qq 1.3.4，pi 1.5.0
> 证据截图：
>
> - pi TUI：`/home/chen/project/pi-qq-test/pi.png`
> - QQ：`/home/chen/project/pi-qq-test/qq.jpg`

## 1. 目标

用户在 QQ 上应该看到 **Skill 的执行**，而不是普通的 `read` 工具执行。

目标格式：

```markdown
## 🧩 Skill

`playwright-cli`

---
```

明确不做：

- 不显示 `SKILL.md` 的完整内容；
- 不显示 skill 的来源路径（全局/项目）；
- 不支持 QQ 侧 `/skill:` 命令；
- 不区分“自动选择”和“显式调用”，只展示 skill 名称。

## 2. 调研结论

### 2.1 pi 的 `[skill]` 是什么

截图中的：

```text
[skill] playwright-cli (ctrl+o to expand)
```

是 pi TUI 对 **读取 `SKILL.md` 的 read 工具** 的特殊渲染，不是独立的 skill 事件。

pi 的 read 渲染器会检测文件名：

```ts
// pi: dist/core/tools/renderers/read.js
if (fileName === "SKILL.md") {
  return { kind: "skill", label: basename(dirname(absolutePath)) };
}
```

所以 TUI 把它折叠成 `[skill]`；会话记录中实际仍然是：

```text
toolCall: read /home/chen/.pi/agent/skills/playwright-cli/SKILL.md
toolResult: SKILL.md 内容
```

对应会话：

```text
/home/chen/.pi/agent/sessions/--home-chen-project-pi-qq-test--/
  2026-11-03T15-37-34-742Z_01a1a20f-0115-7773-a4c5-a011cda00d57.jsonl
```

### 2.2 QQ 当前显示什么

`qq.jpg` 中显示的是：

- `📖 read` 工具气泡；
- 参数路径 `.../playwright-cli/SKILL.md`；
- `SKILL.md` 的完整内容；
- 后续思考和 bash。

因此当前 QQ **有内容**，但语义上是“read 了一个文件”，不是“执行了 skill”。这正是需要改变的地方。

### 2.3 显式 `/skill:` 路径

pi 也支持从 TUI 执行 `/skill:name`，会展开成一条包含 `<skill ...>` 的 user message，并用 `SkillInvocationMessageComponent` 渲染。

但本设计**不支持 QQ `/skill:`**：

- QQ 入站命令路由会把 `/skill:` 当未知命令；
- pi-qq 不转发 user message；
- 这些行为保持不变。

本次只处理模型自动读取 `SKILL.md` 的情况。

## 3. 当前实现路径

模型读取 `SKILL.md` 时，pi-qq 收到普通工具事件：

```text
tool_execution_start: toolName=read, args.path=/.../SKILL.md
tool_execution_end:   result=SKILL.md 内容
```

当前链路：

- `src/relay/run-stream-relay.ts` 把 `read` 加入工具队列；
- `src/relay/bubble-writer.ts` 调用 `formatToolLine("read", args)`；
- `src/relay/stream-block-format.ts` 输出 `**📖 read**` + 路径；
- `onToolEnd` 再输出完整 `SKILL.md` 结果。

没有任何 skill 识别逻辑，所以 QQ 看到的是普通 read。

## 4. 根因

pi 的 `[skill]` 是 **展示层分类**，不是协议事件：

- 没有 `skill_start` / `skill_end`；
- pi-qq 无法从事件类型知道“这是 skill”；
- 唯一可用的信号是 `read` 工具参数中的 `SKILL.md` 路径；
- 当前格式化逻辑没有利用这个信号。

## 5. 修改方案

### 5.1 识别 skill read

新增纯函数，例如：

```ts
export interface SkillRead {
  name: string;
}

export function detectSkillRead(toolName: string, args: unknown): SkillRead | undefined;
```

规则：

- `toolName === "read"`；
- 参数路径的最后一段是 `SKILL.md`；
- 支持 `path` 和 `file_path` 两种参数名；
- 支持 `/` 和 `\` 路径分隔符；
- skill 名称取父目录名：
  - `.../playwright-cli/SKILL.md` → `playwright-cli`；
  - `.../my-skill/SKILL.md` → `my-skill`。

不读取、不解析 `SKILL.md` 内容，也不显示路径。

### 5.2 渲染 skill 气泡

在 `formatToolLine()` 或 `BubbleWriter` 中增加 skill 分支，输出：

```markdown
## 🧩 Skill

`playwright-cli`

---
```

- 标题使用 Markdown 二级标题；
- skill 名称用行内代码；
- 末尾单独一行 `---`；
- 不附加路径、来源、描述或内容。

i18n：

- 英文：`Skill`
- 中文：`技能`
- 默认语言 `zh-cn` 时标题为 `## 🧩 技能`；
- 如果希望固定英文，可把文案设为不翻译。

### 5.3 抑制原 read 工具输出

检测到 skill read 后：

- **不输出** `📖 read` 工具行；
- **不输出** `SKILL.md` 的 tool result；
- 只输出一个 skill 气泡；
- 后续 assistant 文本/工具继续按原顺序输出。

实现上需要在 `ToolCall` 上记录 skill 信息：

```ts
interface ToolCall {
  ...
  skillName?: string;
}
```

- `onToolStart` 检测并写入 `skillName`；
- `startNextTool` 如果 `skillName` 存在，调用 `writer.pushSkill(name)`；
- `finishTool` 对 skill 跳过 `pushToolResult`，但仍清理 active tool、启动下一个工具、flush deferred 文本。

### 5.4 顺序与气泡边界

- skill 气泡独立成泡；
- skill 之后如果还有工具，继续按工具顺序输出；
- 如果 skill 后面是 assistant 文本，文本从新气泡开始；
- 如果同一个 run 多次读取 `SKILL.md`，每次读取都会产生一个 skill 气泡；第一版不做去重。

### 5.5 失败处理

如果 `read SKILL.md` 失败：

- 仍然显示 skill 气泡，提示 skill 已尝试加载；
- 不显示 `SKILL.md` 内容；
- 是否额外显示失败原因，需要确认；建议在 skill 气泡后加一行简短错误，避免用户以为 skill 已成功加载。

## 6. 执行计划

### Phase 1：识别与格式

- [ ] 新增 `detectSkillRead()`，处理 `path` / `file_path`、Unix/Windows 路径；
- [ ] 新增 `formatSkillBlock(name)`；
- [ ] 单元测试：
  - `read .../playwright-cli/SKILL.md` → skill；
  - 普通 `read` 不受影响；
  - Windows 路径；
  - 大小写/非 `SKILL.md` 文件名；
  - 缺少父目录时的回退名称。

### Phase 2：接入 relay

- [ ] `ToolCall` 增加 `skillName`；
- [ ] `onToolStart` 检测 skill；
- [ ] `BubbleWriter` 增加 `pushSkill(name)`；
- [ ] `startNextTool` 对 skill 使用 `pushSkill`；
- [ ] `finishTool` 对 skill 跳过 read 结果；
- [ ] 测试：
  - 只出现 skill 气泡，不出现 read 工具行/结果；
  - skill 与前后工具的顺序；
  - 流式熔断时 skill 仍按现有 fallback 行为；
  - 多个 skill / 多次读取。

### Phase 3：文案与文档

- [ ] i18n 增加 `stream.skill`（`Skill` / `技能`）；
- [ ] 更新 README 的 skill 说明；
- [ ] 更新 `CHANGELOG.md`。

### Phase 4：验证

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run format:check`
- [ ] 在 `pi-qq-test` 中让模型读取 `playwright-cli/SKILL.md`，对比：
  - pi TUI：`[skill] playwright-cli`
  - QQ：`## 🧩 Skill` + `playwright-cli` + `---`
  - QQ 不再出现 `📖 read` 和 `SKILL.md` 全文

## 7. 变更文件

| 文件                                     | 变更                                      |
| ---------------------------------------- | ----------------------------------------- |
| `src/relay/stream-block-format.ts`       | `detectSkillRead()`、`formatSkillBlock()` |
| `src/relay/run-stream-relay.ts`          | `ToolCall.skillName`、start/finish 分支   |
| `src/relay/bubble-writer.ts`             | `pushSkill()`                             |
| `src/infra/i18n.ts`                      | skill 标题文案                            |
| `test/relay/stream-block-format.test.ts` | skill 识别/格式测试                       |
| `test/relay/run-stream-relay.test.ts`    | skill 气泡与 read 抑制测试                |
| `README.md` / `README-zh.md`             | skill 显示说明                            |
| `CHANGELOG.md`                           | `[Unreleased]` 变更                       |

## 8. 已确认

1. QQ 显示 skill 执行，不显示普通 read 工具；
2. 格式为 `## 🧩 Skill` + skill 名称 + `---`；
3. 不显示 `SKILL.md` 完整内容；
4. 不支持 QQ `/skill:` 命令；
5. 不显示 skill 来源。

## 9. 待确认

1. skill 标题是否跟随 `language` 配置（默认中文“技能”，还是固定英文“Skill”）。
2. `read SKILL.md` 失败时是否显示简短错误，还是仅显示 skill 气泡。
3. 同一个 run 多次读取同一 `SKILL.md` 是否去重。
