# `/status` 增强设计

> 状态：设计文档，尚未实现  
> 日期：2026-11-04  
> 涉及版本：pi-qq 1.3.3  
> 范围：QQ `/status` 与终端 `/qq-status`

## 1. 需求

1. **pi 执行状态**：执行中 / 已完成；
2. **电脑电量**；
3. **图标**：让状态行更易扫读；
4. **中英文支持**：所有用户可见文字和日志消息支持 `zh-cn` 和 `en-us`；
5. **语言配置**：通过配置项选择语言，不自动识别系统语言。

QQ `/status` 和终端 `/qq-status` 应保持一致。

## 2. 现状分析

### 2.1 命令入口

QQ 侧 `/status` 在 `src/qq/inbound-command.ts` 中处理：

```ts
case "/status":
  await reply(deps.getStatusLines().join("\n"));
  break;
```

终端 `/qq-status` 在 `index.ts` 中处理：

```ts
pi.registerCommand("qq-status", {
  description: "pi-qq: show login, connection, and bound QQ user",
  handler: async (_args, ctx) => {
    ctx.ui.notify(getStatusLines(ctx).join("\n"), "info");
  },
});
```

两处共用 `index.ts` 中的 `getStatusLines(ctx)`。

### 2.2 当前字段

| 行             | 当前内容                                                          | 数据来源                    |
| -------------- | ----------------------------------------------------------------- | --------------------------- |
| `pi-qq status` | 固定标题                                                          | 无                          |
| `Login`        | QR 登录，AppID 掩码                                               | `getLoginState()`           |
| `Connection`   | `stopped` / `starting` / `connected` / `reconnecting` / `blocked` | `lastState` + `stateDetail` |
| `Model`        | 当前模型名                                                        | `ctx.model`                 |
| `Context`      | tokens / contextWindow / percent                                  | `ctx.getContextUsage()`     |
| `Bound user`   | 绑定的 QQ openid                                                  | `getLoginState()`           |
| `Settings`     | 配置文件路径                                                      | 固定字符串                  |

### 2.3 缺口

1. **没有 agent 执行状态**
   - `ctx.isIdle()` 已经存在，但状态行没有使用；
   - `runFeedback.isQQRunActive()` 已经存在，可以区分 QQ 任务与本地任务。
2. **没有电脑电量**
   - 当前没有电池/电源采集代码；
   - 状态构建函数是同步的，加入平台命令时要考虑阻塞和缓存。
3. **没有图标**
   - 当前 `/status` 是纯文本行；
   - QQ 输出走普通文本消息，emoji 可以直接使用；工具/思考消息已经在用 emoji。
4. **没有中英文支持**
   - 当前所有命令回复、状态、错误提示都是硬编码英文；
   - 没有统一文案表，也没有语言配置。
5. **`Bound user` 显示完整 openid**
   - 建议做掩码处理，和 AppID 保持一致。
6. **信息层级偏平**
   - 登录、连接、模型、上下文、绑定用户之间没有视觉区分。

### 2.4 可用数据

- `ctx.isIdle()`：pi 当前是否空闲；
- `runFeedback.isQQRunActive()`：当前是否有 QQ 触发的 run；
- `lastState` / `stateDetail`：网关连接状态；
- `ctx.getContextUsage()`、`ctx.model`；
- Node 标准库的 `fs` / `child_process`：读取电量，无需新增依赖。

## 3. 术语与需求确认

### 3.1 执行状态的含义

- `running (QQ)`：pi 正在执行，当前 run 由 QQ 消息触发；输出会回传 QQ；
- `running (local)`：pi 正在执行，但 run 由终端/TUI/其他来源触发；输出不会回传 QQ；
- `completed`：pi 当前空闲，没有执行中的 run。

区分 `QQ` / `local` 的价值：用户看到“正在执行但手机没有消息”时，可以判断是 QQ 任务还是本地任务。  
如果不需要这个粒度，统一显示 `running` / `completed` 即可。

### 3.2 电脑电量

已确认需求是“电脑电量”。展示：

- 电池百分比；
- 充电 / 放电 / 已接通电源。

**没有电池（台式机）或读取失败时，直接隐藏 Battery 行**，不显示 `unknown` / `desktop`。  
能返回 `/status` 本身就说明电脑在线，不需要额外展示在线状态。

### 3.3 `QQ user` 是什么（原 `Bound user`）

`QQ user`（原 `Bound user`）是扫码登录时绑定的 QQ 用户 `openid`：

- 用于 allowlist，只接受这个用户的消息；
- 用于主动消息的默认目标；
- 不是 QQ 昵称，而是 QQ 开放平台提供的、按机器人隔离的用户标识。

已确认把标签改为更直观的 `QQ user` / `QQ 用户`，并做掩码：

```text
👤 QQ user: openid-1…
```

### 3.4 图标选择

已采用推荐组合：

| 字段       | 图标 / 状态                                                            |
| ---------- | ---------------------------------------------------------------------- |
| 标题       | 🖥️                                                                     |
| Login      | 🔐；未登录 ⚪                                                          |
| Connection | 🌐 connected / 🔄 reconnecting / ⛔ stopped / 🚫 blocked / ⏳ starting |
| Agent      | 🏃 running / ✅ completed                                              |
| Model      | 🧠                                                                     |
| Context    | 📊                                                                     |
| QQ user    | 👤                                                                     |
| Battery    | 🔋 放电 / 🔌 充电 / ⚡ AC                                              |
| Settings   | ⚙️                                                                     |

Connection 使用网络/链路符号，Agent 使用动作/结果符号，避免两者都用黄绿圆点。

## 4. 修改建议

### 4.1 状态行设计

英文示例：

```text
🖥️ pi-qq status
🔐 Login: QR login (AppID abcd****)
🌐 Connection: connected
🏃 Agent: running (QQ)
🧠 Model: claude-sonnet
📊 Context: 12.3k/200k (6.2%)
👤 QQ user: openid-1…
🔋 Battery: 85% (discharging)
⚙️ Settings: ~/.pi/agent/pi-qq.json
```

中文示例：

```text
🖥️ pi-qq 状态
🔐 登录：扫码登录（AppID abcd****）
🌐 连接：已连接
🏃 执行：执行中（QQ）
🧠 模型：claude-sonnet
📊 上下文：12.3k/200k（6.2%）
👤 QQ 用户：openid-1…
🔋 电量：85%（放电中）
⚙️ 设置：~/.pi/agent/pi-qq.json
```

空闲时：

```text
✅ Agent: completed
⚡ Battery: 100% (AC)
```

没有电池时省略 Battery 行。

### 4.2 执行状态

`getStatusLines(ctx)` 中增加：

```ts
const agentRunning = ctx ? !ctx.isIdle() : runFeedback.isQQRunActive();
const agentLabel = !agentRunning ? "completed" : runFeedback.isQQRunActive() ? "running (QQ)" : "running (local)";
```

- 使用 `ctx.isIdle()` 作为 pi 全局状态；
- 用 `runFeedback.isQQRunActive()` 区分 QQ 任务；
- `ctx` 为空时回退到 `runFeedback.isQQRunActive()`；
- 文案通过 i18n 表输出，不在代码中拼接中英文。

### 4.3 电脑电量

建议新增 `src/infra/power-status.ts`：

```ts
export interface PowerStatus {
  percent?: number;
  state: "charging" | "discharging" | "ac";
}

export function getPowerStatus(): PowerStatus | undefined;
```

- 返回 `undefined` 表示没有电池或读取失败，状态报告直接隐藏 Battery 行；
- **Linux**：读取 `/sys/class/power_supply/BAT*/capacity` 和 `/status`；
- **macOS**：解析 `pmset -g batt`；
- **Windows**：PowerShell `Get-CimInstance Win32_Battery`；
- **缓存**：结果缓存 30 秒，避免每次 `/status` 启动子进程；
- **失败处理**：异常静默返回 `undefined`，不能影响 `/status`；
- 不新增 npm 依赖。

同步 vs 异步：

- 当前 `getStatusLines` 是同步函数；第一版建议同步读取 + 30 秒缓存；
- Linux 文件读取几乎无阻塞；macOS/Windows 子进程只在缓存过期时执行，并设置 500ms 超时；
- 如果后续发现阻塞明显，再改为异步并让 `/status`、`/qq-status` 都 `await`。

### 4.4 提取纯格式化函数

当前 `getStatusLines` 直接拼字符串，难以测试。建议提取：

```ts
export interface StatusReportInput {
  language: Language;
  login?: { appId: string; openid: string };
  connection: { state: BotState; detail?: string };
  agent: { running: boolean; qq: boolean };
  model?: { name: string };
  usage?: ContextUsage;
  power?: PowerStatus;
}

export function formatStatusReport(input: StatusReportInput): string[];
```

职责：

- `index.ts` 收集数据；
- `formatStatusReport()` 负责图标、标签、语言和格式；
- 单元测试覆盖所有状态组合；
- QQ `/status` 和终端 `/qq-status` 使用同一份输出。

### 4.5 中英文与语言配置

新增配置项：

```json
{
  "language": "zh-cn"
}
```

允许值：

- `"zh-cn"`：简体中文；
- `"en-us"`：英文。

默认值：`"zh-cn"`。这是有意的行为变更：升级后默认中文；需要英文时配置 `"language": "en-us"`。

#### 覆盖范围

所有**用户可见文字和日志消息**都应走文案表：

- QQ 命令回复：`/help`、`/status`、`/last`、`/stop`、`/compact`、`/new`、未知命令；
- QQ 错误和提示：附件失败、语音转写失败、unsupported message、模型错误；
- 状态行：登录、连接、执行状态、模型、上下文、QQ 用户、电量、设置；
- 流式输出：思考标题、工具失败标记、`(no output)` 等用户可见占位符；
- 终端 TUI：`/qq-status`、`/qq-login` 提示、连接状态通知、诊断命令；
- 状态细节 `stateDetail` 中的用户提示；
- pi-qq 自己写入的结构化日志消息。

不翻译：

- 日志的 `scope`、字段名、级别等机器可读结构；
- 命令名（`/status`、`/stop`）和配置键；
- 第三方 SDK 返回的原始错误文本和原始日志（可保留英文原文）。

#### 实现建议

新增 `src/infra/i18n.ts`：

```ts
export type Language = "zh-cn" | "en-us";

export function configureI18n(language: Language): void;
export function getLanguage(): Language;
export function t(key: TranslationKey, params?: Record<string, string | number>): string;
```

- 文案放在 `src/infra/i18n/en-us.ts` / `zh-cn.ts`；
- 使用类型化 key，缺少 key 时回退英文并在 debug 日志记录；
- `settings.ts` 增加 `language` 解析和校验，非法值回退默认并警告；
- `applyConfig()` / `session_start` 时调用 `configureI18n(settings.language)`；
- 图标不参与翻译，保持统一；
- 测试：两种语言、占位符、缺失 key 回退、非法配置回退。

#### 日志本地化

日志也支持中英文，但保持机器可读结构：

- 新增稳定的 `msgKey` 字段，例如 `log.session.starting_bot`；
- `msg` 按当前 `language` 输出中文/英文；
- `scope`、`level`、时间、字段名保持英文/固定；
- 日志 API 使用 key，例如 `log.info("session", "log.session.starting_bot", data)`；
- `file-logger` 在写入时解析 key，同时写入 `msgKey` 和本地化后的 `msg`；
- `sdkLogger` 收到的 SDK 原文保持原样，不强行翻译；
- 语言切换只影响后续日志，已经写入的日志保持原语言；
- 默认语言是 `zh-cn`，因此未配置时日志消息也是中文；排障脚本应优先匹配 `scope` / `msgKey`，不要依赖 `msg` 文本。

示例：

```json
{
  "time": "...",
  "level": "info",
  "scope": "session",
  "msgKey": "log.session.starting_bot",
  "msg": "正在启动机器人",
  "appId": "...",
  "allowedOpenid": "..."
}
```

如果现有日志消费方依赖英文 `msg`，需要把它们迁移到 `msgKey`；这是本方案的兼容性成本。

### 4.6 隐私

`Bound user` 当前显示完整 openid。已确认改名为 `QQ user` / `QQ 用户`，并统一掩码，例如 `openid-1…`。  
如果排障需要完整值，只在日志中记录，不通过 QQ `/status` 展示。

## 5. 执行计划

### Phase 1：i18n 基础设施

1. 新增 `src/infra/i18n.ts` 和中英文文案表；
2. `settings.ts` 增加 `language`，默认 `zh-cn`，非法值回退并警告；
3. 在会话启动时 `configureI18n()`；
4. 补 settings/i18n 测试。

### Phase 2：迁移用户可见文字与日志

1. `/help`、`/status`、`/last`、`/stop`、`/compact`、`/new` 等命令回复；
2. 附件失败、语音失败、unsupported message、模型错误；
3. TUI 通知、`/qq-login` 提示、`/qq-status`；
4. 流式输出的用户可见标题和占位符；
5. pi-qq 自有的结构化日志消息迁移到 `msgKey` + 本地化 `msg`；
6. 增加中英文快照测试和日志字段测试。

### Phase 3：状态格式与 Agent 状态

1. 新增 `src/qq/status-report.ts`；
2. `index.ts` 收集登录、连接、agent、model、usage、power 等数据；
3. `ctx.isIdle()` / `runFeedback.isQQRunActive()` 判断 `running (QQ)` / `running (local)` / `completed`；
4. 接入图标和中英文文案；
5. 测试所有状态组合。

### Phase 4：电脑电量

1. 新增 `src/infra/power-status.ts`；
2. 实现 Linux/macOS/Windows 探测和 30 秒缓存；
3. 无电池/读取失败返回 `undefined`，状态报告隐藏 Battery 行；
4. 解析函数独立测试，不依赖当前机器。

### Phase 5：接入、文档与验证

1. 更新 `README.md` / `README-zh.md` 的 `/status`、`/qq-status` 和 `language` 配置；
2. QQ `/status` 保持普通文本，不改成流式；
3. 终端 `/qq-status` 继续使用 `ctx.ui.notify`；
4. 手动验证中英文、执行中/已完成、电量/无电池、断线状态；
5. 运行：

```bash
npm run lint
npm run typecheck
npm test
npm run format:check
```

## 6. 变更文件

| 文件                                    | 变更                                  |
| --------------------------------------- | ------------------------------------- |
| `src/infra/i18n.ts`                     | 新增语言类型、`t()`、语言切换         |
| `src/infra/i18n/en-us.ts`               | 英文文案表                            |
| `src/infra/i18n/zh-cn.ts`               | 中文文案表                            |
| `src/infra/settings.ts`                 | 新增 `language` 解析与校验            |
| `src/infra/power-status.ts`             | 新增电量探测和缓存                    |
| `src/qq/status-report.ts`               | 新增纯格式化函数                      |
| `index.ts`                              | 收集状态数据、初始化 i18n、调用格式化 |
| `src/qq/inbound-command.ts`             | 命令回复走 i18n                       |
| `src/qq/qq-message-handler.ts`          | 入站错误/提示走 i18n                  |
| `src/attachments/attachment-failure.ts` | 附件失败文案走 i18n                   |
| `src/relay/stream-block-format.ts`      | 思考/工具占位符走 i18n                |
| `test/qq/status-report.test.ts`         | 新增状态格式测试                      |
| `test/infra/power-status.test.ts`       | 新增电量解析测试                      |
| `test/infra/i18n.test.ts`               | 新增语言/回退测试                     |
| `README.md` / `README-zh.md`            | 状态与语言配置说明                    |
| `CHANGELOG.md`                          | `[Unreleased]` 增加变更               |

## 7. 已确认

1. 保留 `running (QQ)` / `running (local)` 的区分。
2. 默认语言为 `zh-cn`；需要英文时配置 `"language": "en-us"`。
3. 日志也支持中英文；结构化字段保持稳定，新增 `msgKey`。
4. `Bound user` 改名为 `QQ user` / `QQ 用户`。
5. Connection / Agent 使用推荐图标：`🌐` / `🏃` / `✅`。
6. 无电池或读取失败时隐藏 Battery 行。
