# pi-qq

> pi 扩展：通过 QQ 机器人把 [pi](https://github.com/earendil-works/pi) 接入 QQ 单人私聊（C2C）。
> 手机 QQ 上发消息（文字/图片）→ pi 在机器上干活 → 完整回复（Markdown → 纯文本）+ 用量摘要回传到 QQ。

基于腾讯官方 SDK [`@tencent-connect/qqbot-nodejs`](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs) 与 [`@tencent-connect/qqbot-connector`](https://www.npmjs.com/package/@tencent-connect/qqbot-connector)。

## 功能特性

- **扫码登录 / 配置直连**：`/qq-login` 扫码即用（自动换取凭据并绑定单人），或在配置文件写入 `AppID`/`AppSecret` 免扫码直连
- **单人聊天**：绑定用户私聊消息直接进入 pi 会话（含图片），白名单外的消息完全隔离
- **完整回复**：assistant 消息实时回传（流式追加 / 降级分块），Markdown 转手机可读纯文本
- **长任务反馈**：开始确认 + "正在输入"保鲜 + 节流心跳（`⏱ 已运行 25 分钟 · bash×86 · read×12`），数十分钟级任务不再黑盒等待
- **发送图片**：QQ 端发图 → 自动下载注入 pi 作为视觉输入
- **诊断命令**：`/qq-md`、`/qq-stream-test` 快速验证平台能力

架构与决策记录见 [doc/features.md](./doc/features.md)，实施计划与验收见 [doc/plan.md](./doc/plan.md)。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 登录机器人（二选一）

**方式 A：配置直连（推荐）** — 写入 `~/.pi/agent/pi-qq.json` 后启动 pi 自动连接：

```json
{
    "AppID": "你的 AppID",
    "AppSecret": "你的 AppSecret"
}
```

**方式 B：扫码登录** — pi 中执行 `/qq-login`，用手机 QQ 扫码，凭据自动写回同一文件，
扫码人的 openid 自动绑定为"单人"白名单。

### 3. 加载扩展

```bash
pi --extension /path/to/pi-qq
# 或放入用户扩展目录，所有会话自动加载：
ln -s /path/to/pi-qq ~/.pi/agent/extensions/pi-qq
```

## 配置项

`~/.pi/agent/pi-qq.json`（手动配置或扫码写入，同一文件；除凭据外均可省略）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `AppID` / `AppSecret` | 无 | 机器人凭据（文件权限 `0600`）；存在即免扫码直连（兼容小写 `appId`/`appSecret`） |
| `allowedOpenid` | 扫码自动写入 | 单人绑定的 openid；手动配置时缺省则首个私聊用户自动绑定 |
| `streamAssistant` | `true` | assistant 流式回传开关（关闭则整条回复完成后一次性发送） |
| `markdownSupport` | `false` | 机器人是否有 markdown 权限；`true` 时回传透传原始 Markdown |
| `usageRelay` | `true` | 用量摘要（token/成本/上下文占比）开关 |
| `deliverAs` | `"steer"` | agent 忙碌时新消息的处理方式：`steer` 并入当前任务 / `followUp` 排队 |
| `contextWarnPercent` | `80` | 上下文占比告警阈值，达到后在摘要中提示压缩 |
| `imageMaxSize` | `10485760` | QQ 图片下载上限（字节，默认 10MB） |
| `heartbeatMinutes` | `10` | 长任务心跳间隔（分钟），`0` 关闭 |
| `heartbeatMaxMessages` | `3` | 每 run 消息心跳上限（流式心跳不受限） |
| `streamRelay` | `true` | 流式载体（append 追加语义）；关闭则心跳与结果全走普通消息 |
| `streamFlushMs` | `3000` | 流式汇总帧间隔（毫秒，最小 300） |
| `debug` | `false` | 诊断模式：SDK 日志转终端 + 文本帧带时间戳 |

## 命令

| 位置 | 命令 | 行为 |
| --- | --- | --- |
| pi 侧 | `/qq-login` | 扫码登录/换绑 |
| pi 侧 | `/qq-status` | 登录态、连接状态、绑定用户 |
| pi 侧 | `/qq-logout` | 清除凭据并断开 |
| pi 侧 | `/qq-md [text]` | 诊断：验证 C2C markdown 渲染能力 |
| pi 侧 | `/qq-stream-test` | 诊断：追加模式流式全链路验证 |
| QQ 侧 | `/stop` `/compact` `/status` `/help` | 会话控制（`/new` 需在 pi 终端执行） |

## 一个回合的消息形态

QQ 用户每个回合看到的消息（默认配置下稳定占 2 条被动回复额度）：

```
✅ 已收到，开始处理；长任务预计较久，完成后自动回传   ← 确认（任务开始）
[流式气泡：回复内容逐段追加，心跳行在前]              ← streamRelay 开启时
📊 tokens — 输入 12.3k（缓存命中 11.8k）· 输出 1.2k  ← 用量摘要（M3）
| 上下文 46.5k/200k（23%）
```

## 开发

```bash
npm run typecheck      # 类型检查（npx tsc，无需本地安装）
npx -y jiti test/run.ts  # 单元测试（40 项断言：转换/分块/预算/心跳/流式节流重试）
```

模块划分与事件接线见 [doc/plan.md](./doc/plan.md)；src/ 下每个模块单一职责：
`config`（配置读写）/ `login`（扫码）/ `bot`（生命周期）/ `inbound`（QQ→pi）/
`outbound`（pi→QQ 文本）/ `reply-budget`（被动回复额度）/ `run-feedback`（长任务反馈）/
`append-stream`（追加模式流式发送器）。

## 已知平台限制（实测）

- **流式必须用追加语义**：SDK 内置的 `input_mode="replace"` 被平台拒绝（"已经提交的消息内容不可修改"），
  本项目自实现 append 模式（增量追加 + DONE），见 `src/append-stream.ts`
- **被动回复额度**：每条入站消息约 4 条/小时、msgId 约 5 分钟内有效；超限自动降级主动发送
- **主动消息有严格配额**：长任务的心跳默认走流式（0 额度），消息心跳有保险丝（每 run ≤3 条）
- 流式帧内容类型固定为 markdown（`sendMarkdown` 同理）；无 markdown 渲染能力的场景请关闭 `streamRelay`

## 许可

MIT
