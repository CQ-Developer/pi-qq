# qq_send_media 执行计划

- 关联设计：[`doc/research.md`](./research.md)、[`doc/feature.md`](./feature.md)
- 当前状态：核心实现与自动化测试完成，待真机验证/提交
- 最后更新：2026-11-05

## 1. 目标与范围

实现自定义工具 `qq_send_media`，让模型在用户明确要求时，把本机图片、视频或文件发回当前 QQ 私聊。

本计划的范围：

- 工具注册、参数校验、媒体类型/大小校验。
- QQ 登录成功后激活，登出/停止后停用。
- 上传、发送、被动/主动降级、配额记账。
- 工具气泡保持普通行为。
- 关键点 debug 日志。
- Debug 日志 bugfix：通用 debug 日志不再只在 QQ 登录/QQ 触发 run 时记录。
- 单元测试、集成测试、手工验证、文档更新。

不在范围内：

- 入站文本意图识别（关键词/正则/分类器）。
- 发送前二次确认。
- 语音消息、URL 来源、多文件单次发送。
- 出站文件路径根目录限制。
- 修改 QQ SDK。

## 2. 已确认决策

| 决策      | 结论                                                                     |
| --------- | ------------------------------------------------------------------------ |
| 调用时机  | 只靠工具 `description` + `promptGuidelines` 约束；不做入站解析，不做确认 |
| 工具激活  | 启动 pi 默认未激活；QQ 登录成功后激活；QQ 登出/停止后停用                |
| 断线/重连 | 不改变激活状态；bot 未就绪时 `execute()` 报错                            |
| 文件路径  | 不限制根目录；任意普通文件；拒绝符号链接、目录、设备                     |
| 工具气泡  | 与其它工具一致，只加 `📤` 图标；不抑制、不自定义 renderer                |
| 发送方式  | `uploadMedia()` + `mediaApi.sendMediaMessage()` 两步式                   |
| 配额      | 复用 `ReplyBudget`；被动优先，失败复用 `file_info` 降级主动              |
| 默认配置  | 不新增配置项                                                             |
| 依赖      | 不新增运行时依赖；`typebox` 由 pi 宿主提供                               |

## 3. 交付物

| 类型     | 文件                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 核心实现 | `src/qq/media-tool.ts`                                                     |
| 入口接线 | `index.ts`                                                                 |
| 工具图标 | `src/relay/stream-block-format.ts`                                         |
| 文案     | `src/infra/i18n.ts`                                                        |
| 测试     | `test/qq/media-tool.test.ts`、`test/index.test.ts`、必要的 relay/i18n 测试 |
| 文档     | `README.md`、`README-zh.md`、`CHANGELOG.md`、`doc/plan.md`                 |
| 提交     | 按 §9 的提交记录逐步提交                                                   |

## 4. 执行阶段

### Phase 0：设计文档（已完成）

- [x] 完成 `doc/research.md`：pi 扩展、QQ SDK 媒体能力、现有出站架构、风险。
- [x] 完成 `doc/feature.md`：最终方案、调用时机、登录激活、发送流程、验收标准。
- [x] 提交设计文档：`c360c70 docs: add qq media tool research and design`。

### Phase 1：核心工具

目标：`qq_send_media` 能独立完成参数校验、上传和发送，不依赖入口接线。

- [x] T1.1 新建 `src/qq/media-tool.ts`
  - 常量：`MEDIA_TOOL_NAME = "qq_send_media"`、caption 上限（4500）。
  - 类型：`MediaToolDeps`、`MediaToolController`、`PreparedMedia`。
  - 依赖注入：`getBot`、`getLogin`、`budget`、`onWarn`。
- [x] T1.2 定义 schema 与工具描述
  - `path`：string，必填。
  - `kind`：`auto | image | video | file`，可选，默认 `auto`。
  - `caption`：string，可选。
  - `name`：string，可选，仅 `file` 类型使用。
  - 使用 `Type.Object` / `StringEnum`；`typebox` 来自宿主，不新增依赖。
  - 写入 `doc/feature.md` §3 的 description、`promptSnippet`、`promptGuidelines`。
- [x] T1.3 实现 `prepareMedia(params, cwd)`
  - 去掉路径前导 `@`；相对路径按 `cwd` resolve。
  - `lstat`：拒绝符号链接、目录、设备等非普通文件；拒绝空文件。
  - 类型识别：图片/视频扩展名白名单；音频按 `FILE`；显式 `kind` 覆盖。
  - 大小校验：`getMaxUploadSize(fileType)`；图片 30 MB、视频/文件 100 MB。
  - 文件名：`basename`；`file` 类型允许 `name` 覆盖。
  - 不限制根目录；不检查文件是否在 cwd 内。
- [x] T1.4 实现 `execute()`
  - 检查 `getBot()`、`getLogin()`；未登录/未启动返回 `mediaTool.notConnected`。
  - 检查 `signal.aborted`；开始时和上传后各检查一次。
  - 上传：`bot.uploadMedia({ target: c2c + allowedOpenid, fileType, localPath, fileName, srvSendMsg: false, onProgress })`。
  - 发送：`budget.acquire()` 后调用 `bot.mediaApi.sendMediaMessage()`；`content` 截断到 4500。
  - 成功：被动发送后 `commitPassive(msgId)`。
  - 被动失败：复用 `upload.file_info` 主动重试一次；不重复上传；成功后 `onWarn`。
  - 错误映射：`UploadDailyLimitExceededError`、`ApiError`、文件系统错误。
  - `details` 在 partial（`onUpdate`）和最终结果中保持同一结构。
  - `executionMode: "sequential"`。
  - 同时补齐 `mediaTool.*` 的 i18n key（中英文），供本阶段使用。
- [x] T1.5 实现激活控制器
  - `registerMediaTool(pi, deps)` 返回 `{ activate, deactivate, isActive }`。
  - 注册工具时 `defaultActive: false`。
  - `activate()`：保留其它 active tools，加入 `qq_send_media`；幂等。
  - `deactivate()`：只移除 `qq_send_media`；幂等。
- [x] T1.6 单元测试 `test/qq/media-tool.test.ts`
  - schema/描述/`defaultActive`。
  - 路径规范化、符号链接、目录、空文件、超限。
  - 类型识别和 `kind` 覆盖。
  - 被动成功、主动发送、被动失败复用 `file_info`、上传失败、错误映射。
  - caption 截断、`executionMode`、激活/停用幂等。
- [x] T1.7 关键点 debug 日志
  - 按 `doc/feature.md` §5.2：激活/停用、工具入口、校验结果、上传开始/结束、预算选择、发送结果、最终错误。
  - 统一 `scope: "media"`、`log.debug`，用 `toolCallId` 串联。
  - 不记录文件内容、base64、`file_info` 原文、caption 正文。
  - 单测：mock `log.debug`，断言关键阶段有日志；默认 `silent` 无输出。

**Phase 1 验收**：单元测试覆盖上述分支；`npm run typecheck` 通过；不依赖 `index.ts` 即可测试工具。

### Phase 2：入口接线与生命周期

目标：工具在启动时未激活；QQ 登录成功后激活；登出/停止后停用。

- [x] T2.1 在 `index.ts` 创建控制器
  - 在 `pi` 扩展加载时调用 `registerMediaTool(pi, { getBot: () => running?.bot, getLogin: () => getLoginState(), budget, onWarn })`。
  - 将返回的 controller 保存在闭包变量中；确保 `stopIfRunning()` 可以引用（必要时先声明再赋值）。
- [x] T2.2 激活/停用接线
  - `startWithCredentials()`：`startBot()` 之后调用 `mediaTool.activate()`。
  - `stopIfRunning()`：调用 `mediaTool.deactivate()`。
  - 覆盖 `/qq-login`、`/qq-logout`、`session_start`、`session_shutdown`。
  - 不监听 `onStateChange`；断线/重连不改变 active 状态。
  - 激活/停用时记录关键点 debug 日志。
- [x] T2.3 更新 `test/index.test.ts`
  - fake pi 增加 `registerTool`、`getActiveTools`、`setActiveTools`。
  - 验证扩展加载后工具注册为 `defaultActive: false`。
  - 验证 login 成功后 active set 包含 `qq_send_media`。
  - 验证 `/qq-logout`/`stopIfRunning` 后从 active set 移除。
  - 验证其它工具保持不变。
- [x] T2.4 回归检查
  - `test/qq/qq-message-handler.test.ts` 无需改动；确认没有新增依赖。
  - `test/index.test.ts` 原有生命周期用例仍通过。

**Phase 2 验收**：模拟登录/登出时 active set 正确变化；未登录时工具不可见；已有测试全绿。

### Phase 2.5：Debug 日志 bugfix（追加）

目标：修复“只有 QQ 登录后、QQ 触发的 run 才有较完整 debug 日志”的问题；不改变默认 `silent` 行为。

- [x] T2.5 根因确认
  - 确认 `configureLogger()` 在 `session_start` 已按 `settings.logLevel` 执行，不依赖登录。
  - 确认 `message_end` 的 `if (msg.role !== "assistant" || !running) return;` 在 debug 日志之前，未登录时日志被丢弃。
  - 确认 `src/relay/` 日志只在 QQ run 存在时产生，属于预期；不强行给本地 run 造 relay 日志。
  - 结论写入 `doc/research.md` §4.6。
- [x] T2.6 修复日志调用
  - `message_end`：只保留 `msg.role !== "assistant"` 前置判断，把 debug 日志移到 `!running`/`!fromQQ` 之前。
  - 日志字段增加 `fromQQ`、`hasBot`、`hasLogin`。
  - `agent_start` / `agent_end`：增加 debug 标记（`fromQQ`、`hasBot`、`hasLogin`），覆盖未登录/本地 run。
  - 不修改 `src/relay/`；relay 日志仍只属于 QQ run。
- [x] T2.7 回归测试
  - 未登录 + 本地 run：`agent_start`/`agent_end`/`message_end` 有 debug 日志；无 relay 日志。
  - 已登录 + 本地 run：通用 debug 日志存在；无 relay 日志。
  - 已登录 + QQ run：通用日志和 relay 日志都存在。
  - 默认 `silent`：以上都不写日志。
  - 本地 run 仍然不向 QQ 发送回复。

**Phase 2.5 验收**：三种场景的 debug 日志覆盖符合预期；默认 silent 无输出；现有测试全绿。

### Phase 3：工具气泡、文案与文档

- [x] T3.1 `src/relay/stream-block-format.ts`
  - `TOOL_ICONS` 增加 `qq_send_media: "📤"`。
  - 不增加 `renderCall`/`renderResult`，不修改 `BubbleWriter`/`RunFeedback`。
  - 增加/更新测试，确认 `formatToolLine("qq_send_media", ...)` 输出 `## 📤 qq_send_media`。
- [x] T3.2 `src/infra/i18n.ts`
  - Phase 1 已添加 `mediaTool.*` 基础 key；本阶段复核文案，并补齐 `test/infra/i18n.test.ts` 的必要断言。
- [x] T3.3 `README.md` / `README-zh.md`
  - 新增“回传媒体到 QQ”小节：工具名、调用时机（用户明确要求）、登录后激活、文件上限、被动回复配额、工具气泡。
  - 说明不限制路径根目录；说明模型判断是软约束。
- [x] T3.4 `CHANGELOG.md`
  - `[Unreleased]` 增加 Added/Changed 条目。

**Phase 3 验收**：工具气泡格式正确；中英文文案完整；README/CHANGELOG 与实际行为一致。

### Phase 4：全量验证与手工测试

- [x] T4.1 本地质量门禁
  - `npm run lint`
  - `npm test`
  - `npm run typecheck`
  - `npm run format:check`
  - `npm pack --dry-run`
- [ ] T4.2 真机 QQ 验证
  - 启动 pi 未登录：工具不在 active set，模型看不到。
  - 未登录本地 TUI run：`agent_start`/`agent_end`/`message_end` debug 日志存在；无 relay 日志。
  - 默认 `silent`：不产生日志。
  - 登录后 QQ 触发 run：通用 debug 与 relay 日志都存在。
  - QQ 登录成功：工具出现；`/tools`/日志可确认。
  - 中文/英文/日文/混合表述让 pi 回传截图：模型能理解并调用。
  - 生成图片但未要求回传：模型不调用工具（抽样观察）。
  - 发送图片、视频、文件；caption；`name` 覆盖文件名。
  - 大文件：6 MB 图片走分块；25 MB 图片；>30 MB 图片被拒；>100 MB 文件被拒。
  - 被动窗口过期：确认降级主动消息。
  - 连续发送 4 个媒体：观察最终文本是否降级。
  - 登出：工具消失；重新登录：恢复。
  - 断线/重连：工具保持可见；bot 未就绪时执行报错。
  - 工具气泡：正常显示 `## 📤 qq_send_media`、参数、结果；媒体单独到达。
- [ ] T4.3 记录实测结果
  - 把“媒体是否计入 4 次被动回复”“文件消息权限”“视频格式”“主动媒体 `msg_seq`”“气泡/媒体顺序”的结果补到 `doc/research.md` 或 `doc/plan.md` 的验证记录。

**Phase 4 验收**：质量门禁全绿；手工用例通过或有明确记录；无阻塞性缺陷。

## 5. 详细 Todo List

### 5.1 必做

- [x] `src/qq/media-tool.ts` 新建并实现。
- [x] `index.ts` 注册、激活、停用。
- [x] `index.ts` debug 日志 bugfix：`message_end` 日志前移，`agent_start`/`agent_end` 增加 debug 标记。
- [x] `src/relay/stream-block-format.ts` 图标。
- [x] `src/infra/i18n.ts` 文案。
- [x] `test/qq/media-tool.test.ts`。
- [x] `test/index.test.ts` 更新（生命周期 + debug 日志覆盖）。
- [x] `README.md` / `README-zh.md`。
- [x] `CHANGELOG.md`。

### 5.2 按需

- [x] 补充 `test/relay/stream-block-format.test.ts` 的图标断言。
- [ ] 补充 `test/infra/i18n.test.ts` 的新 key 断言。
- [ ] 在 `doc/research.md` 补充真机验证结果。

### 5.3 明确不做

- 不做入站文本意图识别。
- 不做发送前确认。
- 不新增 `mediaSendMode` 配置。
- 不修改 `src/qq/qq-message-handler.ts`。
- 不限制出站路径根目录。
- 不新增运行时依赖。
- 不手动 `npm publish`。

## 6. 验收标准

### 6.1 功能

- [ ] 未登录/启动时：`qq_send_media` 不在 active set，模型无法调用。
- [ ] QQ 登录成功后：工具在 active set，模型可见。
- [ ] QQ 登出/停止后：工具从 active set 移除。
- [ ] 断线/重连：active 状态不变；恢复后可直接使用。
- [ ] 工具描述和 `promptGuidelines` 明确“仅在用户明确要求时调用”“不确定先问”“不要因为生成文件就调用”。
- [ ] `path` 支持绝对/相对路径、前导 `@`；拒绝符号链接、目录、设备、空文件。
- [ ] 图片/视频/文件按扩展名识别；`kind` 可覆盖；音频按文件发送。
- [ ] 图片 >30 MB、视频/文件 >100 MB 在本地拒绝。
- [ ] 不限制路径根目录。
- [ ] 被动发送成功调用 `commitPassive()`；被动失败复用 `file_info` 主动重试；不重复上传。
- [ ] 错误信息可读：未登录、文件问题、超限、日额度、API 错误。
- [ ] 工具气泡为 `## 📤 qq_send_media`，参数/结果正常回传；不抑制、不特殊渲染。
- [ ] caption 截断到 4500 字符。
- [ ] 开启 `logLevel: "debug"` 后，关键点日志存在且可用 `toolCallId` 串联；默认 `silent` 无输出。
- [ ] 日志不包含文件内容、base64、`file_info` 原文、caption 正文。
- [ ] 未登录 + 本地 run：`agent_start`/`agent_end`/`message_end` 有通用 debug 日志；无 relay 日志。
- [ ] 已登录 + 本地 run：通用 debug 日志存在；无 relay 日志。
- [ ] 已登录 + QQ run：通用日志与 relay 日志都存在。
- [ ] 默认 `logLevel: "silent"`：以上都不写日志。
- [ ] 本地 run 仍然不向 QQ 发送回复。

### 6.2 非功能

- [ ] `npm run lint` 通过。
- [ ] `npm test` 全绿。
- [ ] `npm run typecheck` 通过。
- [ ] `npm run format:check` 通过。
- [ ] `npm pack --dry-run` 成功，包内容包含 `doc/` 与 `src/`。
- [ ] 无新增运行时依赖。
- [ ] 不修改 `src/qq/qq-message-handler.ts`。
- [ ] 不新增配置项。

### 6.3 文档

- [ ] README 中英文说明工具用法、激活时机、配额、限制。
- [ ] CHANGELOG Unreleased 有条目。
- [ ] `doc/plan.md` 的 todo 和提交记录随进度更新。

## 7. 测试矩阵

| 层级 | 用例                            | 预期                                                 |
| ---- | ------------------------------- | ---------------------------------------------------- |
| 单元 | 未登录 `execute`                | 抛 `mediaTool.notConnected`                          |
| 单元 | 符号链接/目录/空文件            | 上传前拒绝                                           |
| 单元 | 图片 30 MB / 视频 100 MB 边界   | 边界内通过，超出拒绝                                 |
| 单元 | `kind=auto` + `.mp3`            | 按 `FILE` 发送                                       |
| 单元 | 被动发送成功                    | 带 `msgId`，`commitPassive` 一次                     |
| 单元 | 被动失败                        | 同一 `file_info` 主动重试，不重复上传                |
| 单元 | `UploadDailyLimitExceededError` | 映射为可读提示                                       |
| 单元 | debug 日志                      | 关键阶段有 `scope: "media"` 记录；默认 silent 无输出 |
| 集成 | 未登录 + 本地 run               | agent/message debug 日志存在；无 relay 日志          |
| 集成 | 已登录 + 本地 run               | agent/message debug 日志存在；无 relay 日志          |
| 集成 | 已登录 + QQ run                 | 通用 debug 与 relay 日志都存在                       |
| 集成 | 默认 silent                     | 不写任何日志                                         |
| 单元 | `ApiError`                      | 带 `bizCode`/`bizMessage`                            |
| 集成 | 扩展加载                        | 注册 `defaultActive: false`                          |
| 集成 | 登录成功                        | active set 包含工具                                  |
| 集成 | 登出/`stopIfRunning`            | active set 移除工具                                  |
| 集成 | 断线/重连                       | active set 不变                                      |
| 手工 | 多语言请求回传                  | 模型理解并调用                                       |
| 手工 | 生成图片但未要求回传            | 不调用                                               |
| 手工 | 图片/视频/文件发送              | QQ 正常显示                                          |
| 手工 | 工具气泡                        | 与其它工具一致                                       |
| 手工 | 连续 4 个媒体                   | 最终文本按预算降级                                   |

## 8. 风险与验证项

| 项                               | 影响             | 处理                                                          |
| -------------------------------- | ---------------- | ------------------------------------------------------------- |
| 模型误调用                       | 未经要求发送媒体 | 已接受软约束；观察真实语料；必要时再考虑确认机制              |
| 媒体是否计入 4 次被动回复        | 配额判断偏差     | 真机验证；必要时调整预算策略                                  |
| C2C 文件消息权限                 | `FILE` 发送失败  | 真机验证；错误提示说明权限可能不足                            |
| 视频格式/编码                    | 平台拒绝         | 先用标准 mp4；记录可用格式                                    |
| 主动媒体 `msg_seq=1`             | 去重/乱序        | 真机验证多条主动媒体                                          |
| 气泡与媒体顺序                   | 体验问题         | 观察流式节流下的实际顺序                                      |
| 大文件上传阻塞                   | 当前 run 等待    | 已接受；后续可考虑后台任务                                    |
| `setActiveTools` 与 session 恢复 | 工具状态不一致   | 启动默认 inactive；登录成功显式 activate；登出显式 deactivate |

## 9. 提交记录

| #   | 提交      | 内容                                                                  | 状态   |
| --- | --------- | --------------------------------------------------------------------- | ------ |
| 0   | `c360c70` | `docs: add qq media tool research and design`                         | 已提交 |
| 1   | `a0e4d93` | `docs: plan debug logging fix and media tool implementation`          | 已提交 |
| 2   | 待定      | `fix: emit debug logs for non-qq runs`（message_end/agent 日志）      | 计划   |
| 3   | 待定      | `feat: add qq_send_media tool core`（media-tool + 单测 + debug 日志） | 计划   |
| 4   | 待定      | `feat: activate qq_send_media after qq login`（index + 生命周期测试） | 计划   |
| 5   | 待定      | `feat: add qq_send_media icon`（relay + 测试）                        | 计划   |
| 6   | 待定      | `docs: document qq_send_media`（README/CHANGELOG）                    | 计划   |
| 7   | 待定      | `chore: release x.y.z`（如需要，交给 GitHub CI）                      | 可选   |

提交要求：

- 每个提交前跑对应测试；最终提交前跑 §6.2 全部门禁。
- 提交信息使用 Conventional Commits（`feat:`、`fix:`、`docs:`、`test:`、`chore:`）。
- 不手动 `npm publish`，不手动创建 GitHub Release；发布走 `v*` 标签和 CI。
- 实际提交后，把哈希和状态补到本表。

## 10. Definition of Done

- [x] `src/qq/media-tool.ts` 完成并通过单测。
- [x] `index.ts` 的登录激活/登出停用接线完成并通过生命周期测试。
- [x] 工具气泡、i18n、README、CHANGELOG 更新完成。
- [x] 关键点 debug 日志完成，单测覆盖。
- [x] Debug 日志 bugfix 完成：未登录/本地 run 也有通用 debug 日志；relay 日志仍只属于 QQ run。
- [x] `npm run lint` / `npm test` / `npm run typecheck` / `npm run format:check` / `npm pack --dry-run` 全绿。
- [ ] 真机验证完成，结果记录在案。
- [ ] 没有遗留的阻塞性 todo；非阻塞项明确记录。
- [ ] 提交记录已更新。

## 11. 参考

| 主题                 | 位置                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| 调研报告             | `doc/research.md`                                                                              |
| 技术方案             | `doc/feature.md`                                                                               |
| pi 自定义工具        | `pi/packages/coding-agent/docs/extensions.md:2180`                                             |
| pi 工具激活          | `pi/packages/coding-agent/docs/extensions.md:1908`、`:2311`                                    |
| QQ 媒体发送          | `qqbot-nodejs/src/QQBot.ts:980`、`:1051`、`:1122`                                              |
| pi-qq 入站/预算/气泡 | `src/qq/qq-message-handler.ts`、`src/quota/reply-quota.ts`、`src/relay/stream-block-format.ts` |
