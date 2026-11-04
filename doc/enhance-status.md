# `/status` 增强设计

> 状态：设计文档，尚未实现  
> 日期：2026-11-04  
> 涉及版本：pi-qq 1.3.3  
> 范围：QQ `/status` 与终端 `/qq-status`

## 1. 需求

在现有状态信息基础上增加：

1. **pi 执行状态**：执行中 / 已完成；
2. **电脑电量**；
3. **图标**：让状态行更易扫读。

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
   - `ctx.isIdle()` 已经存在，但状态行没有使用。
   - `runFeedback.isQQRunActive()` 已经存在，可以用来区分“QQ 任务”与“本地任务”。
2. **没有电脑电量**
   - 当前没有任何电池/电源采集代码。
   - 状态构建函数是同步的，加入平台命令时要考虑阻塞和缓存。
3. **没有图标**
   - 当前 `/status` 是纯文本行。
   - QQ 输出走普通文本消息（不是流式），emoji 可以直接使用；工具/思考消息已经在用 emoji，说明客户端渲染没有问题。
4. **信息层级偏平**
   - 登录、连接、模型、上下文、绑定用户之间没有视觉区分，手机上看一屏文字较难扫读。
5. **`Bound user` 显示完整 openid**
   - 可能不需要改动，但可以顺手做掩码处理，和 AppID 一致。

### 2.4 可用数据

- `ctx.isIdle()`：pi 当前是否空闲；
- `runFeedback.isQQRunActive()`：当前是否有 QQ 触发的 run；
- `lastState` / `stateDetail`：网关连接状态；
- `ctx.getContextUsage()`、`ctx.model`；
- Node 标准库的 `fs` / `child_process`：读取电量，无需新增依赖。

## 3. 需求澄清

### 3.1 电脑电量

已确认需求是“电脑电量”。建议展示：

- 电池百分比；
- 充电 / 放电 / 已接通电源；
- 没有电池（台式机）或读取失败时显示 `unknown` / `desktop`。

不需要额外展示“电脑在线”状态；能返回 `/status` 本身就说明电脑在线。

### 3.2 执行状态的粒度

建议区分三种情况：

- `running (QQ)`：QQ 触发的 run 正在执行；
- `running (local)`：pi 正在执行，但不是 QQ 触发的 run；
- `idle / completed`：当前没有执行。

如果只按需求做两种，统一显示 `running` / `completed` 即可。

## 4. 修改建议

### 4.1 状态行设计

建议输出示例：

```text
🖥️ pi-qq status
🔐 Login: QR login (AppID abcd****)
🌐 Connection: connected
🏃 Agent: running (QQ)
🧠 Model: claude-sonnet
📊 Context: 12.3k/200k (6.2%)
👤 Bound user: openid-1…
🔋 Battery: 85% (discharging)
⚙️ Settings: ~/.pi/agent/pi-qq.json
```

空闲时：

```text
✅ Agent: completed
⚡ Battery: 100% (AC)
```

图标建议：

| 字段       | 图标 / 状态                                                            |
| ---------- | ---------------------------------------------------------------------- |
| 标题       | 🖥️                                                                     |
| Login      | 🔐；未登录 ⚪                                                          |
| Connection | 🌐 connected / 🔄 reconnecting / ⛔ stopped / 🚫 blocked / ⏳ starting |
| Agent      | 🏃 running / ✅ completed                                              |
| Model      | 🧠                                                                     |
| Context    | 📊                                                                     |
| Bound user | 👤                                                                     |
| Battery    | 🔋 放电 / 🔌 充电 / ⚡ AC / ⚪ unknown                                 |
| Settings   | ⚙️                                                                     |

Connection 使用网络/链路符号，Agent 使用动作/结果符号，避免两者都用黄绿圆点。备选方案：

- Connection：`📡` connected / `🔄` reconnecting / `⛔` stopped；
- Agent：`▶️` running / `✅` completed。  
  但 `📡` 更像“信号”，`▶️` 更像“播放”，推荐优先使用上表的 `🌐` / `🏃`。

注意事项：

- QQ `/status` 是普通文本消息，不要使用 Markdown 表格或链接语法；
- 每行保持简短，避免手机窄屏换行过多；
- emoji 在现有 QQ 输出中已验证可用。

### 4.2 执行状态

`getStatusLines(ctx)` 中增加：

```ts
const agentRunning = ctx ? !ctx.isIdle() : runFeedback.isQQRunActive();
const agentLabel = !agentRunning ? "completed" : runFeedback.isQQRunActive() ? "running (QQ)" : "running (local)";
```

- 使用 `ctx.isIdle()` 作为 pi 全局状态；
- 用 `runFeedback.isQQRunActive()` 区分 QQ 任务；
- `ctx` 为空时回退到 `runFeedback.isQQRunActive()`，避免终端上下文缺失时显示错误。

### 4.3 电脑电量

建议新增 `src/infra/power-status.ts`：

```ts
export interface PowerStatus {
  percent?: number;
  state: "charging" | "discharging" | "ac" | "unknown";
}

export function getPowerStatus(): PowerStatus;
```

实现建议：

- **Linux**：读取 `/sys/class/power_supply/BAT*/capacity` 和 `/status`；
  - 多电池时优先显示第一块，或取平均；
  - 没有电池（台式机）返回 `unknown` / `ac`。
- **macOS**：`pmset -g batt` 解析百分比和 `charging` / `discharging` / `AC attached`。
- **Windows**：PowerShell `Get-CimInstance Win32_Battery` 读取 `EstimatedChargeRemaining` 和 `BatteryStatus`，使用超时。
- **缓存**：结果缓存 30 秒，避免每次 `/status` 都启动子进程。
- **失败处理**：所有异常静默降级为 `unknown`，不能影响 `/status` 主流程。
- **依赖**：使用 `node:fs` / `node:child_process`，不新增 npm 依赖。

同步 vs 异步：

- 当前 `getStatusLines` 是同步函数，`handleInboundCommand` 直接调用；为保持接口最小改动，建议先做**同步 + 30 秒缓存**。
- Linux 文件读取几乎无阻塞；macOS/Windows 的子进程命令只在缓存过期时执行，并设置短超时（例如 500ms）。
- 如果后续发现子进程阻塞明显，再把 `getStatusLines` 改为异步，并让 `/status`、`/qq-status` 都 `await`。

### 4.4 提取纯格式化函数

当前 `getStatusLines` 直接拼字符串，难以测试。建议提取：

```ts
export interface StatusReportInput {
  login?: { appId: string; openid: string };
  connection: { state: BotState; detail?: string };
  agent: { running: boolean; qq: boolean };
  model?: { name: string };
  usage?: ContextUsage;
  power?: PowerStatus;
}

export function formatStatusReport(input: StatusReportInput): string[];
```

可以放在 `src/qq/status-report.ts` 或 `src/infra/status-report.ts`，由 `index.ts` 负责收集数据、纯函数负责格式化。

好处：

- 可以单元测试所有状态组合；
- QQ `/status` 和终端 `/qq-status` 永远使用同一份格式；
- 电量、图标、Agent 状态不需要在 `index.ts` 中堆逻辑。

### 4.5 隐私

`Bound user` 当前显示完整 openid。建议与 AppID 一致做掩码：

```text
👤 Bound user: openid-1…
```

如果用户需要完整 openid 排查问题，可以只在终端 `/qq-status` 中显示完整值，QQ `/status` 显示掩码；但这会增加两条输出路径的差异，第一版建议统一掩码。

## 5. 执行计划

### Phase 1：状态格式与 Agent 状态

1. 新增 `src/qq/status-report.ts`，定义输入类型和 `formatStatusReport()`；
2. 在 `index.ts` 中把 `getStatusLines` 改为收集输入并调用格式化函数；
3. 加入 `ctx.isIdle()` / `runFeedback.isQQRunActive()` 判断；
4. 加图标；
5. 为格式化函数补单元测试：connected/running、completed、reconnecting、未登录、unknown。

### Phase 2：电脑电量

1. 新增 `src/infra/power-status.ts`；
2. 实现 Linux/macOS/Windows 探测和 30 秒缓存；
3. 解析函数单独导出，使用固定字符串测试，不依赖当前机器；
4. 在状态报告中接入 `PowerStatus`；
5. 测试：充电、放电、AC、无电池、读取失败。

### Phase 3：接入与文档

1. 更新 `README.md` / `README-zh.md` 的 `/status` 和 `/qq-status` 描述；
2. QQ `/status` 仍是普通文本，不改成流式；
3. 终端 `/qq-status` 继续使用 `ctx.ui.notify`；
4. 检查 emoji 在 TUI 和 QQ 手机端的显示效果。

### Phase 4：验证

```bash
npm run lint
npm run typecheck
npm test
npm run format:check
```

手动验证：

- QQ 发送 `/status`：执行中、已完成、未登录、断线重连四种状态；
- 终端 `/qq-status`：与 QQ 输出一致；
- 拔掉电源/插上电源后等待缓存过期，确认电量状态更新；
- 台式机/无电池环境显示 `unknown` 或 `desktop`。

### 变更文件

| 文件                              | 变更                                  |
| --------------------------------- | ------------------------------------- |
| `src/qq/status-report.ts`         | 新增纯格式化函数                      |
| `src/infra/power-status.ts`       | 新增电量探测和缓存                    |
| `index.ts`                        | 收集状态数据，调用格式化函数          |
| `src/qq/inbound-command.ts`       | 保持 `/status` 调用方式，必要时 await |
| `test/qq/status-report.test.ts`   | 新增格式化测试                        |
| `test/infra/power-status.test.ts` | 新增解析/缓存测试                     |
| `README.md` / `README-zh.md`      | 更新状态说明                          |
| `CHANGELOG.md`                    | `[Unreleased]` 增加变更               |

## 6. 待确认

1. Agent 状态是否要区分 `running (QQ)` / `running (local)`，还是只显示 `running` / `completed`。
2. 状态文字使用英文（当前风格）还是中文（执行中/已完成）。
3. 无电池设备显示 `unknown`、`desktop`，还是隐藏 Battery 行。
4. `Bound user` 是否统一掩码。
5. Connection / Agent 图标是否采用推荐的 `🌐` / `🏃` 组合。
