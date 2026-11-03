# pi-qq

[English](./README.md) | 简体中文

将 [pi](https://github.com/earendil-works/pi) 接入 QQ 私聊。在手机 QQ 上发送文字、语音、图片或文件，pi 在你的电脑上工作，并把结果发回 QQ。

## 安装

```bash
pi install npm:@chen_hu_hu/pi-qq
```

本地开发：

```bash
pi --extension /path/to/pi-qq
```

## 登录

1. 启动 pi。
2. 执行 `/qq-login`。
3. 用手机 QQ 扫描二维码。

登录凭据只保存在进程内存中。重启 pi 后需要重新扫码。`/qq-logout` 会立即清除内存中的凭据。

## 使用

给机器人发送 QQ 私聊消息即可开始任务。

- **文字**：普通聊天消息。
- **语音**：直接使用 QQ 内置 ASR 文本；音频不会下载或保存。如果 ASR 没有返回文本，机器人会提示你重发或改用文字。
- **图片**：作为视觉输入交给 pi。
- **文件**：保存到当前工作区的 `.pi/pi-qq/<sessionId>/uploads/`，并等待你的下一条指令。

### QQ 输出格式

- **思考**：独立气泡，纯文本，首行 `**💭 思考**`；长思考在 12k 行边界续泡时会重复标题。
- **工具**：每次调用独立气泡，首行 `**<图标> <工具名>**`，空行，参数行内代码，空行，结果 `text` 代码块。
- **普通消息**：原文，不加标题。
- **工具图标**：💻 bash、📖 read、📝 write、✏️ edit、🔎 grep、🔍 search、🗂️ find、📁 ls、📋 list、🌐 web、📡 fetch、🗑️ delete、❌ remove、✅ todo、🧪 test；未配置工具使用 🔧。
- **错误恢复**：模型错误后 60 秒内自动恢复的 run 会继续推送到原 QQ 会话；`/stop` 会等待当前工具和流收尾后再回复。

### 文件

**只发送文件不会启动 pi。** 文件会先保存，pi 等待下一条文字或语音指令后再处理。

- 先上传一个或多个文件，再发送文字或语音说明要做什么。
- 下一条文字/语音会作为指令；保存路径、文件大小和原始文件名会加入该提示词。
- 指令到达前上传的多个文件会合并到同一个提示词中。
- `/new` 会清空等待指令的文件。
- 文件按当前 pi 会话隔离。相同文件名且内容相同会复用已有文件；相同文件名但内容不同会保存为 `name-1.ext`；不同文件名但内容相同会分别保存。

pi 看到的文件提示词示例：

```text
User sent the following file via QQ (saved locally; use read/bash or other tools to access it):
- /home/chen/project/myproj/.pi/pi-qq/<sessionId>/uploads/report.pdf (1.4MB, original name: report.pdf)

User message:
Summarize this file.
```

### 语音消息

语音消息使用 QQ 内置 ASR（`asr_refer_text`）。转写文本会作为普通用户文本交给 pi；pi 不会收到音频文件。

- 语音附件不会下载或保存为 `.amr` / `.silk`。
- 不使用本地或外部语音识别服务。
- 如果 QQ ASR 没有返回文本，机器人会回复 `Could not transcribe this voice message; please resend or type it.`，并且不会启动 pi。
- 语音和文字是两条独立的 QQ 消息；需要时按顺序发送。
- 要查看原始 ASR 结果，可将 `logLevel` 设为 `debug`；日志会包含 `asr_refer_text` 和附件元数据。

## 命令

在 pi 终端执行：

| 命令                 | 说明                                    |
| -------------------- | --------------------------------------- |
| `/qq-login`          | 扫码登录并绑定扫码的 QQ 用户            |
| `/qq-status`         | 显示登录、连接、模型、上下文和绑定用户  |
| `/qq-logout`         | 退出登录并清除内存中的凭据              |
| `/qq-test-budget`    | 显示被动回复额度和流式气泡诊断信息      |
| `/qq-test-md [text]` | 发送 Markdown 测试消息                  |
| `/qq-test-stream`    | 运行流式时间线诊断（`resume` 验证续写） |
| `/qq-new`            | 重置当前会话（由 QQ 侧 `/new` 调用）    |

QQ 侧命令：

| 命令       | 说明                 |
| ---------- | -------------------- |
| `/new`     | 开始新的 pi 会话     |
| `/stop`    | 中止当前运行         |
| `/compact` | 压缩当前上下文       |
| `/status`  | 显示会话和上下文状态 |
| `/help`    | 显示命令帮助         |

## 设置

创建 `~/.pi/agent/pi-qq.json` 覆盖默认值。该文件只保存设置；凭据不会写入其中。

```json
{
  "thinkingRelay": true,
  "logLevel": "silent"
}
```

| 配置项          | 默认值     | 说明                                                   |
| --------------- | ---------- | ------------------------------------------------------ |
| `thinkingRelay` | `true`     | 以 `💭 思考` 标题的纯文本回传思考；`false` 时隐藏      |
| `deliverAs`     | `"steer"`  | 忙碌时新消息的排队方式：`steer` 或 `followUp`          |
| `imageMaxSize`  | `10485760` | QQ 图片下载上限（字节，10MB）                          |
| `fileMaxSize`   | `52428800` | QQ 文件下载上限（字节，50MB）                          |
| `logLevel`      | `"silent"` | 日志阈值：`silent`、`error`、`warn`、`info` 或 `debug` |

启用日志后，日志写入 `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`。可用 `PI_QQ_LOG_DIR` 覆盖目录。`info` 只记录元数据；`debug` 记录完整事件、附件、提示词和工具参数/结果。旧配置 `debug: true` 会映射为 `logLevel: "debug"`。

## 开发

需要 Node.js 22.19 或更高版本（与 pi 的要求一致）。安装依赖后运行：

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run format:check
```

`eslint.config.ts` 使用 Node.js 原生 TypeScript 剥离能力加载，不需要 `jiti`。

## 说明

- 仅支持 C2C（QQ 私聊）。
- QQ 入站消息触发的任务会回传 QQ；模型错误后的自动恢复 run 也会继续回传。无关的本地任务不推送 QQ。
- 收到的图片会作为视觉输入传给模型；当前模型必须支持图片输入。
- 保存的文件位于工作区 `.pi/` 下；如有需要，请把 `.pi/` 加入你自己的项目 `.gitignore`。
- QQ 对每条入站消息的被动回复次数有限制。可用 `/qq-test-budget` 查看本地额度。

## 交付文档

- [delivery-v1.md](./doc/delivery-v1.md)
- [delivery-v2.md](./doc/delivery-v2.md)
- [delivery-v3.md](./doc/delivery-v3.md)
