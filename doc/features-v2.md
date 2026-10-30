# pi-qq — features-v2.md

> V2 增量：F8 语音自动转写、F9 轻量日志基础设施。
> 基线见 [features-v1.md](./features-v1.md)；本文只描述新增/变更内容。

## 1. 背景与结论

- 当前语音附件被当作普通文件保存，pi 只能本地解码 SILK 并转写；慢且可能误识别。
- 实测确认 C2C 语音消息的 `attachments[]` 包含 `asr_refer_text`（示例：`"测试。"`），`content` 为空；SDK 1.0.5 已透传该字段。
- 结论：直接使用 QQ 内置 ASR；不下载语音附件，不接本地或外部 STT。

## 2. F8 语音消息自动转写

### 触发与识别

- 仅 C2C、白名单用户。
- `content_type === "voice"` 视为语音消息。
- 读取并 trim `asr_refer_text`。

### 行为

| 情况        | 处理                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| 有 ASR 文本 | `markQQTrigger()` → `pi.sendUserMessage(text, { deliverAs })`                         |
| ASR 为空    | 回复 `Could not transcribe this voice message; please resend or type it.`，不触发 run |
| 语音消息    | 不下载 `url` / `voice_wav_url`，不保存文件，不走图片/文件分支                         |

- 语音和文字是两条独立消息，不做同条组合。
- 转写文本不参与 QQ 命令解析，作为普通用户消息交给 pi。
- 正常一条语音消息只有一个语音附件；多值时按顺序换行拼接，仅作防御。

### 不实现

- 本地 Whisper 或外部 STT 回退
- 保存原始语音

### 代码边界

- 新增 `src/voice.ts`：`isVoiceAttachment()`、`resolveVoiceTranscript()`。
- `src/inbound.ts`：在图片/文件分流前增加语音分支，处理完直接返回。

### 验收

- 发语音后 pi 直接收到文本，不出现 `.amr` / `.silk` 路径。
- 无 `ffmpeg`、`pilk`、`faster-whisper` 等调用，工作区不新增语音文件。
- 空 ASR 只回提示，不启动 agent。
- 文字、图片、文件行为不变。

## 3. F9 日志基础设施

### 实现

- 自研轻量 logger，不引入第三方框架。
- 单文件按天：`<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`；可用 `PI_QQ_LOG_DIR` 覆盖。
- 每条一行 JSON：`time`、`level`、`scope`、`msg` + 结构化字段。
- 日志写入失败不得影响 QQ 消息处理。
- SDK 日志接入同一 logger。

### 配置

```json
{
  "logLevel": "silent"
}
```

| 级别     | 输出                                                 |
| -------- | ---------------------------------------------------- |
| `silent` | 不写日志（默认）                                     |
| `error`  | error                                                |
| `warn`   | warn + error                                         |
| `info`   | info + warn + error                                  |
| `debug`  | 全部，含 raw 事件、附件、prompt、工具参数/结果、正文 |

- 配置键使用 `logLevel`，不使用 `log_level`。
- 移除 `debug` 配置；旧 `debug: true` 迁移为 `logLevel: "debug"`，其他情况默认 `silent`。
- 移除 `debug` 控制的 QQ 气泡时间戳；日志级别不影响聊天展示。
- `info` 只记元数据（如 `hasAsr`、`asrLength`）；`debug` 才记录 `asr_refer_text` 全文和完整附件。

### 验收

- 各级别过滤正确；默认 `silent` 不产生日志。
- `logLevel: "debug"` 能看到语音原始附件和 ASR 文本；`info` 看不到正文。
- 旧 `debug` 配置可迁移。
- 日志路径、日期滚动、写入失败降级正常。

## 4. 配置变更

| 配置       | 变更                 |
| ---------- | -------------------- |
| `logLevel` | 新增；默认 `silent`  |
| `debug`    | 移除；仅保留迁移读取 |

## 5. 限制

- `asr_refer_text` 可能为空或识别不准确；V2 只提示用户重发或改用文字，不做回退。
- `debug` 日志可能包含消息正文和 URL token，仅在排查时本地开启。
