/**
 * 单测：markdownToPlain / chunkText / ReplyBudget / AppendStream / RunFeedback / Usage / Images / Inbound。
 * 运行：npx -y jiti test/run.ts（零测试框架依赖；后续可迁移 vitest）。
 */
import assert from "node:assert/strict";
import { markdownToPlain, chunkText, TEXT_CHUNK_LIMIT } from "../src/outbound.ts";
import { ReplyBudget } from "../src/reply-budget.ts";
import { getSettings } from "../src/config.ts";
import {
  buildImageMessageContent,
  formatBytes,
  formatImageFailures,
  resolveImageMime,
  resolveInboundImages,
} from "../src/images.ts";
import { formatTokenCount, formatUsageSummary, sumUsageMessages } from "../src/usage.ts";
import { createInboundHandler } from "../src/inbound.ts";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${msg}`);
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  try {
    assert.deepEqual(actual, expected);
  } catch (e) {
    console.error(`FAIL: ${msg}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`ok: ${msg}`);
}

// ———— getSettings ————

eq(getSettings({}).streamFlushMs, 10_000, "汇总帧默认 10s");
eq(getSettings({ streamFlushMs: 3000 }).streamFlushMs, 3000, "streamFlushMs 可显式覆盖");

// ———— markdownToPlain ————

eq(markdownToPlain("# 标题\n正文"), "标题\n正文", "标题去 #");
eq(markdownToPlain("**粗** 和 *斜* 与 __粗__"), "粗 和 斜 与 粗", "强调标记去除");
eq(markdownToPlain("运行 `npm test` 看结果"), "运行 npm test 看结果", "行内代码去反引号");
eq(markdownToPlain("见 [文档](https://x.cn/a) 说明"), "见 文档（https://x.cn/a） 说明", "链接转 文字（url）");
eq(markdownToPlain("地址 [https://x.cn](https://x.cn)"), "地址 https://x.cn", "文字与 url 相同只留 url");
eq(markdownToPlain("![架构图](https://x.cn/i.png)"), "架构图", "图片保留 alt");
eq(markdownToPlain("- 项目一\n- 项目二\n1. 甲"), "• 项目一\n• 项目二\n1. 甲", "无序列表转 •、有序保留");
eq(markdownToPlain("> 引用内容"), "引用内容", "引用去 >");
eq(
  markdownToPlain("| a | b |\n|---|---|\n| 1 | 2 |"),
  "a | b\n1 | 2",
  "表格逐行退化（分隔行丢弃）",
);
eq(markdownToPlain("```\ncode **keep**\n```"), "code **keep**", "围栏内容原样保留");
eq(markdownToPlain("上文\n---\n下文"), "上文\n\n下文", "水平线转空行");
eq(markdownToPlain("~~删除~~"), "删除", "删除线去除");
eq(markdownToPlain("snake_case_word 保留"), "snake_case_word 保留", "下划线标识符不被误删");
eq(markdownToPlain("a\n\n\n\nb"), "a\n\nb", "压缩多余空行");

// ———— chunkText ————

eq(chunkText("短文本"), ["短文本"], "短文本不分块");
const lines = Array.from({ length: 100 }, (_, i) => `第 ${i} 行内容 padding padding padding`).join("\n");
const chunks = chunkText(lines, 200);
ok(chunks.every((c) => c.length <= 200), "分块均不超限");
eq(chunks.join(""), lines, "分块无损拼接");
const noNewline = "x".repeat(1000);
const hardChunks = chunkText(noNewline, 300);
eq(hardChunks.join(""), noNewline, "无换行硬切仍无损");
eq(hardChunks.length, 4, "硬切块数正确（1000/300）");
ok(chunkText("a".repeat(TEXT_CHUNK_LIMIT)).length === 1, "等于上限时不分块");

// ———— ReplyBudget ————

const t0 = 1_700_000_000_000;
const budget = new ReplyBudget();

eq(budget.acquire(t0).mode, "proactive", "无入站记录 → proactive");

budget.observeInbound("openid-U", "msg-1", t0);
eq(budget.acquire(t0), { mode: "passive", openid: "openid-U", msgId: "msg-1" }, "新鲜入站 → passive");

// 同一 msgId 连续 4 次被动后，第 5 次降级（限制按 msgId 计数）
const same = new ReplyBudget();
same.observeInbound("openid-U", "msg-x", t0);
for (let i = 0; i < 4; i++) {
  const r = same.acquire(t0);
  ok(r.mode === "passive", `同 msgId 第 ${i + 1} 次被动允许`);
  same.commitPassive(r.msgId!);
}
eq(same.acquire(t0).mode, "proactive", "同 msgId 第 5 次 → 超限降级");

budget.observeInbound("openid-U", "msg-stale", t0);
eq(budget.acquire(t0 + 6 * 60_000).mode, "proactive", "msgId 超 5 分钟 → 过期降级");
eq(budget.acquire(t0 + 4 * 60_000).mode, "passive", "5 分钟内仍可被动");

// 新 msgId 独立计数
budget.observeInbound("openid-U", "msg-fresh-2", t0);
const fresh = budget.acquire(t0);
ok(fresh.mode === "passive" && fresh.msgId === "msg-fresh-2", "新 msgId 独立额度");

// ———— RunFeedback.formatHeartbeat ————

import { RunFeedback, formatHeartbeat } from "../src/run-feedback.ts";

const MIN = 60_000;
eq(formatHeartbeat(30 * 1000, new Map()), "⏱ 已运行 不到 1 分钟（尚未产生工具调用）", "心跳：无工具调用");
const tools = new Map<string, { count: number; errors: number }>([
  ["bash", { count: 86, errors: 3 }],
  ["read", { count: 12, errors: 0 }],
]);
eq(formatHeartbeat(25 * MIN, tools), "⏱ 已运行 25 分钟 · [86] 🔧 bash · [12] 🔧 read · 3 失败", "心跳：含失败数");
tools.get("bash")!.errors = 0;
eq(formatHeartbeat(65 * MIN, tools), "⏱ 已运行 65 分钟 · [86] 🔧 bash · [12] 🔧 read", "心跳：无失败时省略失败段");

// ———— AppendStream：节流 / 无损 / DONE / 限流重试 ————

import { AppendStream } from "../src/append-stream.ts";

function makeFakeApi() {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    failNext: 0,
    async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
      if (api.failNext > 0) {
        api.failNext -= 1;
        const err = new Error("HTTP 429 rate limited") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      calls.push(req);
      return { id: `sm-${calls.length}` };
    },
  };
  return { api, calls };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

{
  const { api, calls } = makeFakeApi();
  const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", { throttleMs: 20, retryBaseMs: 5 });
  const pieces = Array.from({ length: 20 }, (_, i) => `片段${i},`);
  for (const p of pieces) await stream.append(p);
  ok(calls.length <= 4, `20 次快速 append 仅 ${calls.length} 帧（节流生效）`);
  await stream.done();
  const content = calls.map((c) => c.content_raw as string).join("");
  eq(content, pieces.join(""), "节流分帧后内容无损、顺序正确");
  const last = calls[calls.length - 1];
  eq(last.input_state, 10, "最后一帧为 DONE");
  eq(last.content_raw, "", "DONE 帧不携带内容");
  ok(new Set(calls.map((c) => c.index as number)).size === calls.length, "index 递增不重复");
}

{
  const { api, calls } = makeFakeApi();
  api.failNext = 2; // 前两帧限流，第 3 次重试成功
  const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", { throttleMs: 20, retryBaseMs: 5 });
  await stream.append("限流重试片段");
  await stream.done();
  ok(calls.length >= 2, "限流退避后重试成功");
  const content = calls.map((c) => c.content_raw as string).join("");
  eq(content, "限流重试片段", "重试不丢内容、不重复");
}

// ———— RunFeedback：重复文本 / 气泡封口回归 ————

function makeRunHarness() {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
      calls.push({ ...req });
      return { id: `sm-${calls.length}` };
    },
  };
  const bot = {
    messageApi: api,
    getCredentials: () => ({}),
    sendTyping: async () => {},
  };
  const deps = {
    bot: () => bot,
    budget: new ReplyBudget(),
    boundOpenid: () => "openid-u",
    getHeartbeatMinutes: () => 0,
    getHeartbeatMaxMessages: () => 3,
    getStreamFlushMs: () => 300,
    getStreamRelay: () => true,
    getDebug: () => false,
    makeChannel: () => ({ budget: new ReplyBudget(), boundOpenid: "openid-u" }),
    onWarn: () => {},
  };
  return { rf: new RunFeedback(deps as never), calls };
}

const DONE_STATE = 10; // StreamInputState.DONE

/** 按 DONE 帧切分气泡，返回每个气泡的累计内容 */
function collectBubbles(calls: Array<Record<string, unknown>>): string[] {
  const bubbles: string[] = [];
  let current = "";
  for (const c of calls) {
    if (c.input_state === DONE_STATE) {
      bubbles.push(current.trim());
      current = "";
    } else {
      current += c.content_raw as string;
    }
  }
  return bubbles;
}

{
  const { rf, calls } = makeRunHarness();
  rf.markQQTrigger("openid-u", "msg-1");
  rf.onAgentStart();
  await rf.onAssistantDelta("前半", "");
  await rf.flushWindow();
  await rf.onAssistantDelta("前半后半", "");
  await rf.flushWindow();
  ok(await rf.onAssistantFinal("前半后半", false), "流式接管首条消息");
  await rf.onAgentEnd();

  const generating = calls
    .filter((c) => c.input_state !== DONE_STATE)
    .map((c) => c.content_raw as string)
    .join("");
  eq(generating, "前半后半", "同一消息多次快照只发送一份全文（不重复）");
  eq(calls.filter((c) => c.input_state === DONE_STATE).length, 1, "单条文本消息只封一个气泡");
  eq(calls.at(-1)?.input_state, DONE_STATE, "run 结束时最后气泡收到 DONE");
}

{
  const { rf, calls } = makeRunHarness();
  rf.markQQTrigger("openid-u", "msg-2");
  rf.onAgentStart();
  await rf.onAssistantDelta("第一条", "");
  await rf.onAssistantFinal("第一条", false);
  await rf.onAssistantDelta("第二条", "");
  await rf.onAssistantFinal("第二条", false);
  await rf.onAgentEnd();

  const bubbles = collectBubbles(calls);
  eq(bubbles, ["第一条", "第二条"], "两条文本消息各成一个气泡，内容不重复");
  eq(calls.at(-1)?.input_state, DONE_STATE, "多气泡 run 结束时最后气泡收到 DONE");
}

{
  const { rf, calls } = makeRunHarness();
  rf.markQQTrigger("openid-u", "msg-before-text");
  rf.onAgentStart();
  rf.onToolStart("bash");
  await rf.flushWindow(); // 先形成纯工具活动气泡
  rf.onAssistantDelta("中间消息", "");
  await rf.flushWindow(); // 文本首个增量 → 封口活动气泡，文本单独成泡
  await rf.onAssistantFinal("中间消息", false);
  rf.onToolStart("write");
  await rf.flushWindow(); // 文本定稿后的工具进新的活动气泡
  await rf.onAgentEnd();

  const bubbles = collectBubbles(calls);
  eq(bubbles.length, 3, "活动气泡与文本气泡相互独立");
  ok(/^\[\d{2}:\d{2}:\d{2}\] \[1\] 🔧 bash$/.test(bubbles[0]), "活动气泡的工具行使用 [n] 🔧 name 格式");
  eq(bubbles[1], "中间消息", "assistant 文本是纯文本气泡（不含工具行）");
  ok(/^\[\d{2}:\d{2}:\d{2}\] \[1\] 🔧 write$/.test(bubbles[2]), "文本之后的工具另起活动气泡");
}

{
  const { rf, calls } = makeRunHarness();
  rf.markQQTrigger("openid-u", "msg-interleaved");
  rf.onAgentStart();
  rf.onToolStart("write");
  await rf.flushWindow(); // 活动 1
  rf.onAssistantDelta("消息一", "");
  await rf.flushWindow(); // 文本 1
  await rf.onAssistantFinal("消息一", false);
  rf.onToolStart("read");
  await rf.flushWindow(); // 活动 2
  rf.onAssistantDelta("消息二", "");
  await rf.flushWindow(); // 文本 2
  await rf.onAssistantFinal("消息二", false);
  rf.onToolStart("bash");
  await rf.flushWindow(); // 活动 3
  rf.onAssistantDelta("最终回复", "");
  await rf.flushWindow(); // 文本 3
  await rf.onAssistantFinal("最终回复", false);
  await rf.onAgentEnd();

  const bubbles = collectBubbles(calls);
  eq(bubbles.length, 6, "每条文本消息与每段活动各成独立气泡");
  eq(bubbles[1], "消息一", "中间消息一为纯文本气泡");
  eq(bubbles[3], "消息二", "中间消息二为纯文本气泡");
  eq(bubbles[5], "最终回复", "最终回复为纯文本气泡");
  ok(/^\[\d{2}:\d{2}:\d{2}\] \[1\] 🔧 write$/.test(bubbles[0]), "活动 1 只含工具汇总");
  ok(/^\[\d{2}:\d{2}:\d{2}\] \[1\] 🔧 read$/.test(bubbles[2]), "活动 2 只含工具汇总");
  ok(/^\[\d{2}:\d{2}:\d{2}\] \[1\] 🔧 bash$/.test(bubbles[4]), "活动 3 只含工具汇总");
}

{
  const { rf, calls } = makeRunHarness();
  rf.markQQTrigger("openid-u", "msg-3");
  rf.onAgentStart();
  await rf.onAssistantDelta("部分输出", "");
  await rf.flushWindow();
  eq(await rf.onAssistantFinal("部分输出", true), false, "错误消息不走流接管");
  await rf.onAgentEnd();
  eq(calls.at(-1)?.input_state, DONE_STATE, "错误路径也会封口气泡（不留下生成中状态）");
}

{
  const { rf, calls } = makeRunHarness();
  rf.markQQTrigger("openid-u", "msg-4");
  rf.onAgentStart();
  await rf.onAssistantDelta("先行", "");
  await rf.flushWindow();
  // 定稿时补上剩余增量：仍属于同一条消息，不能切泡
  await rf.onAssistantFinal("先行后补", false);
  await rf.onAgentEnd();

  const bubbles = collectBubbles(calls);
  eq(bubbles, ["先行后补"], "同一条消息定稿时的残余增量不切泡");
}

{
  const { rf, calls } = makeRunHarness();
  rf.markQQTrigger("openid-u", "msg-textless");
  rf.onAgentStart();
  // 消息 1：thinking + write（无文本）
  rf.onAssistantDelta("", "思考 1");
  await rf.onAssistantFinal("", false);
  rf.onToolStart("write");
  await rf.flushWindow();
  // 消息 2：thinking + 文本 + read
  rf.onAssistantDelta("文件已写好", "思考 2");
  await rf.onAssistantFinal("文件已写好", false);
  rf.onToolStart("read");
  // 不立即 flush：模拟 read 与下一条消息 thinking 落在同一个 10s 窗口
  // 消息 3：thinking + bash（无文本）
  rf.onAssistantDelta("", "思考 3");
  await rf.onAssistantFinal("", false);
  rf.onToolStart("bash");
  await rf.flushWindow();
  // 消息 4：最终文本
  rf.onAssistantDelta("最终回复", "");
  await rf.onAssistantFinal("最终回复", false);
  await rf.onAgentEnd();

  const bubbles = collectBubbles(calls);
  eq(bubbles.length, 4, "无文本 assistant 消息不会吞掉后续行组");
  ok(
    (bubbles[0].match(/思考中/g) ?? []).length === 2 && bubbles[0].includes("[1] 🔧 write"),
    "活动 1 含两条消息的思考标记与 write",
  );
  eq(bubbles[1], "文件已写好", "中间文本仍为纯文本气泡");
  const readAt = bubbles[2].indexOf("[1] 🔧 read");
  const thinkingAt = bubbles[2].indexOf("💭 思考中...");
  const bashAt = bubbles[2].indexOf("[1] 🔧 bash");
  ok(
    readAt >= 0 && thinkingAt > readAt && bashAt > thinkingAt,
    "活动 2 严格按事件顺序显示 read → thinking → bash",
  );
  eq(bubbles[3], "最终回复", "最终回复为纯文本气泡");
}

// ———— images：F3 ————

eq(resolveImageMime("image/jpeg", "a.jpg"), "image/jpeg", "图片 mime：jpeg");
eq(resolveImageMime("image/jpg", "a.jpg"), "image/jpeg", "图片 mime：image/jpg 归一化");
eq(resolveImageMime("image/png; charset=binary", "a"), "image/png", "图片 mime：忽略参数");
eq(resolveImageMime("application/octet-stream", "b.PNG"), "image/png", "图片 mime：按扩展名兜底");
eq(resolveImageMime("image/svg+xml", "evil.png"), null, "图片 mime：明确 image/* 不支持时拒绝");
eq(resolveImageMime("text/plain", "noext"), null, "图片 mime：未知类型拒绝");
eq(formatBytes(10 * 1024 * 1024), "10.0MB", "图片大小格式化：MB");

eq(buildImageMessageContent("hi", []), "hi", "图片消息：无图片时保持字符串");
const sampleImage = { type: "image" as const, data: "AAA", mimeType: "image/png" };
eq(buildImageMessageContent("", [sampleImage]), [sampleImage], "图片消息：仅图片");
eq(
  buildImageMessageContent("hi", [sampleImage]),
  [{ type: "text", text: "hi" }, sampleImage],
  "图片消息：文本 + 图片保持顺序",
);
eq(
  formatImageFailures([{ filename: "a.png", reason: "过大" }], 0),
  "⚠️ 附件处理失败：\n• a.png：过大",
  "图片失败提示：全部失败",
);
eq(
  formatImageFailures([{ filename: "a.png", reason: "过大" }], 1),
  "⚠️ 有 1 个附件未处理（成功 1 个）：\n• a.png：过大",
  "图片失败提示：部分成功",
);

{
  const png = Uint8Array.from([137, 80, 78, 71]);
  const result = await resolveInboundImages(
    [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
    1024,
    async () =>
      new Response(png, {
        headers: { "content-type": "image/png", "content-length": String(png.length) },
      }),
  );
  eq(result.failures, [], "图片下载：成功无失败");
  eq(result.images.length, 1, "图片下载：数量正确");
  eq(result.images[0]?.mimeType, "image/png", "图片下载：mime 正确");
  eq(result.images[0]?.data, Buffer.from(png).toString("base64"), "图片下载：base64 正确");
}

{
  let fetched = false;
  const result = await resolveInboundImages(
    [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png", size: 99_999 }],
    1024,
    async () => {
      fetched = true;
      return new Response();
    },
  );
  eq(result.images.length, 0, "图片下载：元数据超限不注入");
  ok(!fetched && (result.failures[0]?.reason.includes("图片过大") ?? false), "图片下载：超限在下载前拒绝");
}

{
  const big = new Uint8Array(32);
  const result = await resolveInboundImages(
    [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
    10,
    async () => new Response(big, { headers: { "content-type": "image/png" } }),
  );
  eq(result.images.length, 0, "图片下载：实际内容超限不注入");
  ok(result.failures[0]?.reason.includes("图片过大") ?? false, "图片下载：流式读取时限制大小");
}

{
  const result = await resolveInboundImages(
    [{ content_type: "image/svg+xml", url: "https://example.com/a.svg", filename: "a.svg" }],
    1024,
    async () => new Response(),
  );
  eq(result.images.length, 0, "图片下载：不支持类型不注入");
  ok(result.failures[0]?.reason.includes("不支持的附件类型") ?? false, "图片下载：不支持类型有明确原因");
}

// ———— inbound：/new 命令 ————

function makeInboundHarness(isIdle: boolean) {
  const sent: string[] = [];
  const userMessages: Array<{ content: unknown; options: unknown }> = [];
  let triggers = 0;
  const bot = {
    async sendText(_target: unknown, text: string) {
      sent.push(text);
      return {};
    },
  };
  const ctx = {
    isIdle: () => isIdle,
    ui: { notify: () => {} },
    model: { input: ["text"] },
  };
  const deps = {
    pi: {
      sendUserMessage(content: unknown, options: unknown) {
        userMessages.push({ content, options });
      },
    },
    ctx,
    budget: new ReplyBudget(),
    getAllowedOpenid: () => "openid-u",
    getBoundOpenid: () => "openid-u",
    getDeliverAs: () => "steer",
    getImageMaxSize: () => 1024,
    getStatusLines: () => [],
    onWarn: () => {},
    markQQTrigger: () => {
      triggers += 1;
    },
  };
  const handler = createInboundHandler(deps as never);
  const run = () =>
    handler(
      bot as never,
      {
        kind: "c2c",
        senderId: "openid-u",
        messageId: "msg-new",
        content: "/new",
        attachments: [],
      } as never,
    );
  return { run, sent, userMessages, triggers: () => triggers };
}

{
  const h = makeInboundHarness(true);
  await h.run();
  eq(h.sent, ["正在重置会话…"], "QQ /new：idle 时回复正在重置");
  eq(
    h.userMessages,
    [{ content: "/qq-new", options: { expandPromptTemplates: true } }],
    "QQ /new：调用 qq-new 扩展命令",
  );
  eq(h.triggers(), 0, "QQ /new：不触发 agent run");
}

{
  const h = makeInboundHarness(false);
  await h.run();
  eq(h.sent, ["任务运行中，请先 /stop 再重置会话"], "QQ /new：busy 时拒绝重置");
  eq(h.userMessages, [], "QQ /new：busy 时不调用扩展命令");
}

// ———— usage：F5/F6 ————

function makeUsage(input: number, output: number, cacheRead: number) {
  return { input, output, cacheRead, cacheWrite: 0 };
}

eq(formatTokenCount(999), "999", "token 格式化：小于 1k");
eq(formatTokenCount(1000), "1k", "token 格式化：整千省略 .0");
eq(formatTokenCount(12_345), "12.3k", "token 格式化：一位小数");
eq(formatTokenCount(200_000), "200k", "token 格式化：200k");

eq(
  formatUsageSummary({
    usage: { input: 4, output: 2_300, cacheRead: 4_096, cacheWrite: 0 },
    context: { tokens: 4_100, contextWindow: 1_048_600, percent: 0.4 },
  }),
  "📊 用量摘要\n• 输入：4.1k (99.9%)\n• 输出：2.3k\n• 上下文：0.4%",
  "用量摘要：严格三行格式（输入=总输入，括号=累计缓存命中率）",
);

eq(
  formatUsageSummary({
    usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 },
  }),
  "📊 用量摘要\n• 输入：500 (0.0%)\n• 输出：20\n• 上下文：未知",
  "用量摘要：无缓存/上下文时显示 0.0%/未知",
);

eq(
  formatUsageSummary({
    usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 50 },
    context: { tokens: null, contextWindow: 1_048_600, percent: null },
  }),
  "📊 用量摘要\n• 输入：200 (25.0%)\n• 输出：20\n• 上下文：重建中",
  "用量摘要：cacheWrite 计入总输入；压缩后显示重建中",
);

eq(
  formatUsageSummary({
    usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 },
    context: { tokens: 500, contextWindow: 2_000, percent: null },
  }),
  "📊 用量摘要\n• 输入：500 (0.0%)\n• 输出：20\n• 上下文：25.0%",
  "用量摘要：上下文 percent 缺失时按 tokens/window 计算",
);

const runMessages = [
  { role: "assistant", usage: makeUsage(4, 1_000, 2_000) },
  { role: "toolResult", usage: makeUsage(3, 100, 96) },
  { role: "user" },
  { role: "assistant", usage: makeUsage(1, 50, 0) },
];
eq(
  sumUsageMessages(runMessages as never),
  { input: 8, output: 1_150, cacheRead: 2_096, cacheWrite: 0 },
  "本次 run 汇总：assistant + toolResult 嵌套 usage",
);

console.log(`\nALL PASS (${passed} assertions)`);
