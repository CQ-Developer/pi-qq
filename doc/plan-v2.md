# pi-qq — plan-v2.md

> 执行计划。功能范围见 [features-v2.md](./features-v2.md)；本文只回答：改哪些文件、按什么顺序做、每步怎么验收。
> V2 范围：F8 语音自动转写、F9 轻量日志基础设施。不引入新依赖。

## 0. 前置与范围

- 无新增 npm 依赖；日志使用 Node 标准库自研。
- 基线：当前 v1 代码，`npm test` 77 个测试通过。
- 不实现：本地 Whisper、外部 STT、保存原始语音、语音命令解析。
- 语音只处理 `content_type === "voice"`；不扩展其他媒体类型。
- 日志默认 `silent`；需要排查时手动改为 `info` / `debug`。

## 1. 目录与模块

```text
pi-qq/
├── src/
│   ├── logger.ts          # 新增：级别过滤、JSONL、按天单文件、SDK logger 适配
│   ├── voice.ts           # 新增：语音附件判断、ASR 文本提取
│   ├── config.ts          # 修改：logLevel、旧 debug 迁移
│   ├── inbound.ts         # 修改：语音分支 + 日志分级
│   ├── bot.ts             # 修改：接入 logger，移除 debug 选项
│   ├── index.ts           # 修改：配置 logger，移除 getDebug，日志分级
│   ├── outbound.ts        # 修改：发送日志分级
│   └── run-feedback.ts    # 修改：移除 debug 时间戳，改用 logger
├── test/
│   ├── logger.test.ts     # 新增
│   ├── voice.test.ts      # 新增
│   ├── config.test.ts     # 新增或扩展现有设置测试
│   ├── inbound.test.ts    # 修改
│   └── run-feedback.test.ts # 修改
├── README.md              # 修改：logLevel、日志路径、语音说明
└── doc/features-v2.md     # 已存在，按实现结果校正
```

## 2. 执行步骤

### M5a-1 — 实现 logger

**改动**

1. 新增 `src/logger.ts`：
   - `LogLevel = "silent" | "error" | "warn" | "info" | "debug"`。
   - `configureLogger(level, dir?)`、`getLogLevel()`。
   - `log.error/warn/info/debug(scope, message, data?)`。
   - `sdkLogger`：适配 SDK 的 `(message, meta?)` 接口，统一写入同一个 logger。
   - `previewForLog(value, maxChars)`：截断工具参数/结果。
   - 级别过滤：只输出当前级别及以上；`silent` 不写。
   - 输出一行 JSON：`time`、`level`、`scope`、`msg` + 结构化字段。
   - 文件路径：`<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`。
   - `PI_QQ_LOG_DIR` 可覆盖目录，供测试使用。
   - 每次写入时重新计算日期；跨天自动换文件。
   - 日志写入失败静默忽略，不影响消息处理。
2. 不新增 `debug-log.ts`；不保留临时调试文件。

**验证**

- 单测覆盖：级别过滤、日期文件名、`previewForLog`、写入失败不抛错。
- `logLevel: "silent"` 不产生文件。
- `logLevel: "debug"` 能写入一行合法 JSON。
- `src/logger.ts` 不依赖第三方包。

### M5a-2 — 配置与接线

**改动**

1. `src/config.ts`：
   - 新增 `logLevel?: LogLevel`，默认 `silent`。
   - 保留 `debug?: boolean` 仅用于旧配置迁移：`debug: true` → `logLevel: "debug"`，其他情况默认 `silent`。
   - `ResolvedSettings` 移除 `debug`。
2. `src/index.ts`：
   - 在 `session_start` / `startWithCredentials` 读取设置并 `configureLogger(settings.logLevel)`。
   - 日志目录使用当前工作区 `ctx.cwd`；未配置时 logger 回退到 `process.cwd()`。
   - 移除 `getDebug` 依赖和 `settings.debug` 传递。
3. `src/bot.ts`：
   - `StartBotOptions` 移除 `debug`。
   - `new QQBot({ logger: sdkLogger })`。
   - 连接状态用 info；连接失败/异常用 error；入站 raw 用 debug。
4. `src/inbound.ts` / `src/outbound.ts`：
   - 详细事件用 debug。
   - 入站/出站摘要用 info。
   - 附件失败、ASR 为空、发送降级用 warn。
   - 发送失败、handler 异常用 error。
5. `src/run-feedback.ts`：
   - 移除 `getDebug` 和 QQ 气泡时间戳。
   - 内部诊断改用 `log.debug` / `log.warn`。

**验证**

- `getSettings({}).logLevel === "silent"`。
- `getSettings({ debug: true }).logLevel === "debug"`。
- `getSettings({ logLevel: "info" }).logLevel === "info"`。
- 非法 `logLevel` 回退到 `silent`。
- 代码中除迁移读取外不再引用 `debug` 配置。
- `npm run typecheck` 通过。

### M5a-3 — 日志行为验收

**验证**

1. `logLevel: "silent"`：发送 QQ 消息后，`<cwd>/.pi/pi-qq/logs/` 不新增日志。
2. `logLevel: "info"`：日志只含元数据，不含消息正文、prompt、工具参数。
3. `logLevel: "debug"`：日志包含 raw 事件、附件、prompt、工具参数/结果、消息正文。
4. 日期跨天：用注入时间或临时目录测试文件名从 `pi-qq-YYYY-MM-DD.log` 切换。
5. 目录不可写：消息仍正常处理，进程不崩溃。

### M5b-1 — 实现语音模块

**改动**

1. 新增 `src/voice.ts`：
   - `isVoiceAttachment(attachment)`：仅当 `content_type === "voice"` 返回 true。
   - `resolveVoiceTranscript(attachments)`：
     - 只读取语音附件。
     - `asr_refer_text` 去首尾空白。
     - 过滤空值；多个非空文本按附件顺序换行拼接。
     - 无有效文本返回 `undefined`。
2. 不下载 `url` / `voice_wav_url`，不保存语音文件。

**验证**

- `content_type === "voice"` 识别为语音。
- 普通文件、图片不识别为语音。
- `asr_refer_text` 为 `"测试。"` 返回 `"测试。"`。
- 空字符串、纯空白、缺失返回 `undefined`。
- 多个语音附件按顺序合并。

### M5b-2 — 接入 inbound

**改动**

1. `src/inbound.ts` 在图片/文件分流前增加语音分支：
   - 提取 ASR 文本。
   - 有文本：`markQQTrigger()` → `pi.sendUserMessage(text, { deliverAs })`，然后返回。
   - 无文本：回复 `Could not transcribe this voice message; please resend or type it.`，不触发 run，然后返回。
2. 语音分支不调用 `resolveInboundImages()`，不调用 `saveInboundFiles()`。
3. 语音与文字不组合，语音转写不参与 QQ 命令解析。
4. 更新 `test/inbound.test.ts`：
   - 有 ASR：`sendUserMessage` 收到文本；`saveFiles` 未被调用；`markQQTrigger` 调用 1 次。
   - 空 ASR：只回复提示；不发送 user message；不触发 run。
   - 语音不产生文件保存调用。
   - 文字、图片、文件现有用例不回归。

**验证**

- `npm test -- test/voice.test.ts test/inbound.test.ts` 通过。
- 语音消息不会出现在 `saveInboundFiles()` 的附件参数中。
- 空 ASR 不会启动 agent。

### M5b-3 — 文档与清理

**改动**

1. `README.md`：
   - 设置表移除 `debug`，新增 `logLevel`（默认 `silent`）。
   - 说明日志路径 `<cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log`。
   - Usage 增加语音：直接使用 QQ ASR，不保存语音文件。
2. `doc/features-v2.md`：按最终实现校正配置、日志路径和验收项。
3. 确认 `log/` 下历史调试日志不进入提交；不新增代码向 `log/` 写入。
4. 检查全仓库不再有 `debug` 配置引用（迁移读取除外）。

**验证**

- README 的配置示例与实际 `getSettings` 一致。
- `rg "debug"` 只命中迁移代码、历史文档或无关的调试函数名。
- `npx prettier --check .` 通过。

## 3. Todo-List

### 准备

- [x] 阅读 `doc/features-v2.md`，确认范围仅为 F8/F9
- [x] 运行基线 `npm test`、`npm run typecheck`
- [x] 确认不新增 npm 依赖

### F9 — 日志基础设施

- [x] `src/logger.ts`：级别、过滤、JSONL、按天单文件
- [x] `src/logger.ts`：`PI_QQ_LOG_DIR` 覆盖、写入失败降级
- [x] `src/logger.ts`：`sdkLogger` 适配器
- [x] `src/config.ts`：`logLevel` 默认 `silent`，旧 `debug` 迁移
- [x] `src/index.ts`：`configureLogger`、移除 `getDebug`
- [x] `src/bot.ts`：接入 `sdkLogger`，移除 `debug` 选项
- [x] `src/inbound.ts` / `src/outbound.ts`：日志分级
- [x] `src/run-feedback.ts`：移除 debug 时间戳，改用 logger
- [x] `test/logger.test.ts`：级别、文件名、截断、写入失败
- [x] `test/config.test.ts`：默认值、显式级别、旧配置迁移
- [x] `test/run-feedback.test.ts`：移除 debug 时间戳用例
- [x] 验证 silent / info / debug 三档行为

### F8 — 语音自动转写

- [x] `src/voice.ts`：`isVoiceAttachment()`、`resolveVoiceTranscript()`
- [x] `test/voice.test.ts`：识别、trim、空值、多值合并
- [x] `src/inbound.ts`：语音分支前置
- [x] `src/inbound.ts`：有 ASR 发送文本，无 ASR 回复提示
- [x] `src/inbound.ts`：语音不下载、不保存、不走图片/文件
- [x] `test/inbound.test.ts`：有 ASR / 空 ASR / 不保存文件
- [x] 确认文字、图片、文件用例不回归

### 文档与收尾

- [x] `README.md`：`logLevel`、日志路径、语音说明
- [x] `doc/features-v2.md`：与实现保持一致
- [x] 清理临时调试说明
- [x] `npm test`
- [x] `npm run typecheck`
- [x] `npm run format:check`
- [x] QQ 实机语音验收

## 4. 整体验证标准

### 自动化

- `npm test` 全部通过；新增 `logger` / `voice` / `inbound` 用例。
- `npm run typecheck` 无错误。
- `npm run format:check` 通过。
- 全仓库无第三方日志依赖，`package.json` 依赖不变。

### 实机验收

1. QQ 发送语音“测试”：pi 直接收到 `"测试。"`，不是 `.amr` / `.silk` 路径。
2. 不出现 `ffmpeg`、`pilk`、`faster-whisper` 等工具调用。
3. 工作区 `.pi/pi-qq/` 下不新增该语音文件。
4. 发送无法识别的语音或模拟空 ASR：QQ 收到提示，pi 不启动 run。
5. `logLevel: "silent"`：不产生日志文件。
6. `logLevel: "debug"`：日志文件包含 `asr_refer_text` 和完整附件；`info` 不含正文。
7. 旧配置 `debug: true` 仍能开启 debug 日志。
8. 文字、图片、文件消息行为与 v1 一致。

## 5. 风险与预案

| 风险 | 影响 | 预案 |
| --- | --- | --- |
| ASR 为空或识别不准 | 语音无法转写 | 回复提示重发或打字；V2 不做语音回退 |
| 平台只返回 `voice` 的假定失效 | 语音分支不触发 | 以实测字段为准；若变化再扩展识别条件 |
| 日志目录不可写 | 无日志 | 捕获写入异常，消息处理继续 |
| 默认 `silent` 导致排查时无日志 | 诊断困难 | README 明确开启 `logLevel: "info"` / `"debug"` |
| 移除 debug 时间戳影响现有诊断 | QQ 气泡少时间戳 | 已确认日志级别不影响聊天展示；需要时后续加独立开关 |

## 6. 执行记录

- 2026-10-30：M5a / M5b 代码与单测完成；`npm test` 97 项通过，`npm run typecheck`、`npm run format:check` 通过。
- 2026-10-30：QQ 实机语音验收通过。两条语音均直接使用 `asr_refer_text` 进入 pi；未保存 `.amr`，未调用本地转写工具；`logLevel: "debug"` 日志包含 ASR 元数据与全文。
