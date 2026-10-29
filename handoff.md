# pi-qq 交接文档（handoff）

> 一次性交接文档，写给下一个接手的会话/开发者。读完本文 + `doc/features.md` + `doc/plan.md` 即可继续开发。
> 交接时间：2026-10-29。工作区状态：干净（全部已提交），tsc 0 错误，49 项断言全过。

## 1. 项目是什么

pi 扩展（TypeScript，运行在 pi 进程内）：把 pi 接入 QQ 单人私聊（C2C）。手机 QQ 发消息（文字/图片）→ pi 在机器上干活 → 回复以**回合时间线流式气泡**回传，附用量摘要。用户工作流：`user_input → thinking+tools（10~60 分钟）→ assistant message → user_input`。

| 依赖 | 用途 |
| --- | --- |
| `@tencent-connect/qqbot-nodejs` ^1.0.5 | QQ 开放平台协议层（WebSocket Gateway、C2C 消息、流式、媒体） |
| `@tencent-connect/qqbot-connector` ^1.2.0 | 扫码登录（换取 AppID/AppSecret） |
| `qrcode-terminal` ^0.12 | 终端二维码渲染 |

**必须知道**：扩展以 pi 同等权限运行；QQ 端白名单外的消息不进入 pi。

## 2. 当前状态

| 里程碑 | 状态 | 内容 |
| --- | --- | --- |
| M1 登录接入 | ✅ 验收通过 | 配置直连（`AppID`/`AppSecret`）+ 扫码登录，凭据存 `~/.pi/agent/pi-qq.json`（`0600`） |
| M2 单人聊天 | ✅ 验收通过 | C2C 白名单（首个私聊用户自动绑定）、QQ 命令、文本注入 pi、完整回复非流式路径、被动回复预算 |
| M2.5 长任务反馈 | ✅ 三轮实测通过 | 回合时间线流式气泡、汇总帧、活性线、降级链（详见 §4） |
| M3 用量摘要 | ⬜ 未开始 | `agent_end` 发 `📊 tokens — 输入…（缓存命中…）· 输出… · 成本… \| 上下文…%`（spec 见 features.md F5/F6） |
| M4 打磨 | ⬜ 未开始 | F3 图片（QQ→pi）、`markdownSupport` 透传、剩余打磨项 |

测试：`npx -y -p typescript tsc --noEmit`（0 错误）+ `npx -y jiti test/run.ts`（**49 项断言**：markdown 转换/分块/预算状态机/心跳文案/流式节流重试/**气泡切分回归**）。加载冒烟：`pi -e /home/chen/project/pi-qq -p "回复 ok"`。

## 3. 已完成工作与关键实现

**文件地图**（约 1800 行）：

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 薄装配层：命令注册（qq-login/status/logout/md/stream-test）、`session_start/shutdown`、pi 事件接线（agent_start/end、message_start/update/end、tool_execution_start/end） |
| `src/config.ts` | `~/.pi/agent/pi-qq.json` 读写（`0600`、大写键归一化、损坏拒写） |
| `src/login.ts` | F1 扫码（connector + TUI 二维码弹窗，Esc 取消） |
| `src/bot.ts` | QQBot 生命周期、中间件链（messageFilter/contentSanitizer/accessPolicy/concurrencyGuard）、状态跟踪、致命关闭码上报 |
| `src/inbound.ts` | QQ→pi：白名单 → QQ 命令 → 确认消息 → `markQQTrigger` → `pi.sendUserMessage` |
| `src/outbound.ts` | pi→QQ 文本：`markdownToPlain`（可单测）、`chunkText`（4500 上限）、`sendReply`（预算发牌 + 降级） |
| `src/reply-budget.ts` | 被动回复预算：复用 SDK `ReplyLimiter`（4 条/h/msgId）+ 5min 新鲜度，超限降级主动 |
| `src/run-feedback.ts` | **F7 核心**：回合时间线流式（见 §4） |
| `src/append-stream.ts` | 追加模式流式发送器（节流合帧 500ms + 限流退避重试） |
| `test/run.ts` | 单测（jiti + assert，零测试框架） |

**消息流**：QQ 消息 → 确认消息（被动）→ 注入 pi → 流式时间线气泡 → 用量摘要（M3）。

## 4. 平台实测结论（⚠️ 最高价值的交接知识，全部实测得出）

1. **流式必须用追加语义**：SDK 内置 `StreamSession` 硬编码 `input_mode="replace"`，平台拒绝（“已经提交的消息内容不可修改”，首帧可渲染、后续帧报错）。自实现 `AppendStream`（`input_mode="append"`，每帧发增量）实测可用。
2. **流式帧按 markdown 渲染**：表格/代码块/加粗均正常 → 流内传**原始 Markdown**；`markdownToPlain` 只用于降级后的普通消息路径。
3. **被动回复额度**：约 4 条/h/msgId、msgId 约 5 分钟内有效（SDK `ReplyLimiter` 语义）。超限降级主动发送——**主动消息配额稀缺，勿烧**。
4. **请求级超时**：SDK ApiClient 每请求 30s（AbortController），timeout **不重试**（SDK 策略，AppendStream 一致）。超时 → 帧失败 → 气泡弃用 + 未发文本自动转消息路径（`handleStreamError`）。
5. **typing**：每 50s 续期（平台窗口 ~60s），0 额度。
6. **三轮实测踩坑史**（详见 doc/plan.md 决策记录）：① flush 丢 `resultSentLen` 推进 → 全文重复重发；② 同消息增量误切泡 + `sealBubble` 捕获过期 cur → 气泡卡“生成中”/回复重复 3 份。均已修复并有回归断言。

**当前流式行为**（`streamRelay: true` 默认开）：每条**带文本的** assistant 消息一个独立气泡（文本 + 其后工具执行）；纯思考/工具的回合并入当前气泡；气泡内每 `streamFlushMs`（3000ms）发一帧汇总（`💭 思考中...` / `🔧 name * n` 行组 + 空行 + 文本增量，行组首行带 `[HH:MM:SS]` 时间戳）；空窗口静默 ≥60s 补活性 `⏱` 行；帧失败弃气泡 + 未发文本兜底补发。

## 5. 下一步（按优先级）

1. **M3 用量摘要**（下一个里程碑，spec 已定稿）：`agent_end` 时发一条 `📊 tokens — 输入 X（缓存命中 Y）· 输出 Z · 成本 $C · 本轮 N | 上下文 T/W（P%）`。
   - 数据源：最后一条 assistant 的 `usage`（本轮）、`session_start` 从 `sessionManager.getBranch()` 重建会话累计（`/new` 清零）、`ctx.getContextUsage()`（`tokens===null` 显示“重建中”）。
   - 走 `sendReply` 预算链；`usage.cost.total` 模型无定价时省略；占比 ≥`contextWarnPercent` 追加“建议 /compact”。
2. **M4 图片**（F3）：入站 `attachments` 下载（超时/`imageMaxSize`/类型校验）→ `ImageContent[]` 随文本注入；失败 QQ 提示。
3. **可选打磨**：`/new` 的 QQ 侧支持（当前提示去终端）、长代码块→文件附件（已决策未实现）、`markdownSupport: true` 透传、多气泡模式下的被动额度实测。
4. **悬而未决**：用户曾报告“很多超时”未见实体日志；已加 `debug` 开关（SDK 日志转终端），复现时开启抓取。

## 6. 相关资源

| 资源 | 位置 |
| --- | --- |
| 本仓库 | `/home/chen/project/pi-qq`（git `main`，远程待配置：`git remote add origin <url> && git push -u origin main`） |
| 设计文档 | `doc/features.md`（功能+决策记录）、`doc/plan.md`（计划+todo+实测记录） |
| 用户配置 | `~/.pi/agent/pi-qq.json`（当前含 `debug: false`；凭据勿外泄/勿打印） |
| SDK 本地源码 | `/home/chen/project/qqbot-nodejs`（`src/streaming.ts`、`src/protocol/utils/reply-limiter.ts`、`USAGE.md` 最常查） |
| SDK npm 包 | `node_modules/@tencent-connect/qqbot-nodejs`（纯 ESM，`/protocol` 子导出有 `MessageApi`/`getNextMsgSeq`/`ReplyLimiter`） |
| pi 扩展文档 | `/home/chen/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`（另有 tui.md、configuration.md） |
| 实测样本 | `log/`（QQ 截图、`pi.jsonl` 会话导出；已被 .gitignore 排除） |

## 7. Git 记录

远程仓库待用户提供。提交历史（`main`，从旧到新）：

```
3768207 feat: pi-qq 扩展——QQ 单人私聊接入 pi          （M1+M2 初版）
c8cf559 docs: features/plan 移入 doc/，新增 README
fe13093 feat: 流式气泡升级为回合活动时间线
1ba7ed1 feat: 流式时间线改为固定 3s 窗口汇总帧
66b9d9b feat: 汇总帧顺序改为文本先行/工具在后，推送间隔可配
4ecdd3b fix: 汇总帧推进 resultSentLen 基准（修文本重复重发），行组补回图标
f619d22 feat: 汇总帧时间戳 + 空窗口 60s 活性行 + flush 队列串行化
4fac856 feat: debug 诊断开关（SDK 日志转终端 + 文本帧时间戳）
36be195 docs: M2.5 二轮实测验收通过
1d4e533 feat: 流式时间线改为每回合一个独立气泡
f806065 fix: 气泡按文本消息切分（修双份工具行/迷你气泡/空白戳），关闭 debug
6fb9ff6 fix: 三轮实测回归——同消息增量不切泡/sealBubble 重读 cur/错误路径封口 + 流式回归断言   ← HEAD
```

## 8. 工作约定与注意事项

- **依赖**：新增依赖须先向用户说明并经确认（历史先例：`qrcode-terminal`、`@types/node` 借用 pi 发行目录、typecheck 走 `npx -y -p typescript tsc`）。
- **文件操作**：用文件工具（read/edit/write），不用 shell 脚本改文件。
- **用户配置**：`~/.pi/agent/pi-qq.json` 含密钥——脚本处理时不得打印内容。
- **测试约定**：单测用 jiti + assert 风格（`npx -y jiti test/run.ts`），零测试框架；改动 `run-feedback.ts`/`outbound.ts` 后必须跑 typecheck + 全量断言。
- **模型行为差异**：用户的模型（deepseek-v4.1-flash）每轮工具调用都发独立小消息——涉及“回合/消息”粒度的逻辑都要考虑这种碎片化。
- **QQ 平台限制是硬约束**：任何回传策略改动先对照 features.md §3 的额度表。
