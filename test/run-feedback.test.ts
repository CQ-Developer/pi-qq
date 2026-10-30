import { describe, expect, it } from "vitest";
import { RunFeedback, formatHeartbeat } from "../src/run-feedback";
import { ReplyBudget } from "../src/reply-budget";

const DONE_STATE = 10;
const MIN = 60_000;

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
  const budget = new ReplyBudget();
  const deps = {
    bot: () => bot,
    budget,
    boundOpenid: () => "openid-u",
    getHeartbeatMinutes: () => 0,
    getHeartbeatMaxMessages: () => 3,
    getStreamFlushMs: () => 300,
    getStreamRelay: () => true,
    makeChannel: () => ({ budget: new ReplyBudget(), boundOpenid: "openid-u" }),
    onWarn: () => {},
  };
  return { rf: new RunFeedback(deps as never), calls, budget };
}

/** Split bubbles on DONE frames and return each bubble's accumulated content. */
function collectBubbles(calls: Array<Record<string, unknown>>): string[] {
  const bubbles: string[] = [];
  let current = "";
  for (const call of calls) {
    if (call.input_state === DONE_STATE) {
      bubbles.push(current.trim());
      current = "";
    } else {
      current += call.content_raw as string;
    }
  }
  return bubbles;
}

describe("formatHeartbeat", () => {
  it("无工具调用", () => {
    expect(formatHeartbeat(30 * 1000, new Map())).toBe("⏱ Running for less than 1 minute (no tool calls yet)");
  });

  it("含失败数", () => {
    const tools = new Map<string, { count: number; errors: number }>([
      ["bash", { count: 86, errors: 3 }],
      ["read", { count: 12, errors: 0 }],
    ]);
    expect(formatHeartbeat(25 * MIN, tools)).toBe(
      "⏱ Running for 25 minutes · [🔧] [86] bash · [🔧] [12] read · 3 failed",
    );
  });

  it("无失败时省略失败段", () => {
    const tools = new Map<string, { count: number; errors: number }>([
      ["bash", { count: 86, errors: 0 }],
      ["read", { count: 12, errors: 0 }],
    ]);
    expect(formatHeartbeat(65 * MIN, tools)).toBe("⏱ Running for 65 minutes · [🔧] [86] bash · [🔧] [12] read");
  });
});

describe("RunFeedback 气泡切分", () => {
  it("同一消息多次快照只发送一份全文，单条消息只封一个气泡", async () => {
    const { rf, calls } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-1");
    rf.onAgentStart();
    await rf.onAssistantDelta("前半", "");
    await rf.flushWindow();
    await rf.onAssistantDelta("前半后半", "");
    await rf.flushWindow();
    expect(await rf.onAssistantFinal("前半后半", false)).toBe(true);
    await rf.onAgentEnd();

    const generating = calls
      .filter((call) => call.input_state !== DONE_STATE)
      .map((call) => call.content_raw as string)
      .join("");
    expect(generating).toBe("前半后半");
    expect(calls.filter((call) => call.input_state === DONE_STATE)).toHaveLength(1);
    expect(calls.at(-1)?.input_state).toBe(DONE_STATE);
  });

  it("两条文本消息各成一个气泡，内容不重复", async () => {
    const { rf, calls } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-2");
    rf.onAgentStart();
    await rf.onAssistantDelta("第一条", "");
    await rf.onAssistantFinal("第一条", false);
    await rf.onAssistantDelta("第二条", "");
    await rf.onAssistantFinal("第二条", false);
    await rf.onAgentEnd();

    expect(collectBubbles(calls)).toEqual(["第一条", "第二条"]);
    expect(calls.at(-1)?.input_state).toBe(DONE_STATE);
  });

  it("活动气泡与文本气泡相互独立，文本之后的工具另起活动气泡", async () => {
    const { rf, calls } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-before-text");
    rf.onAgentStart();
    rf.onToolStart("bash");
    await rf.flushWindow();
    rf.onAssistantDelta("中间消息", "");
    await rf.flushWindow();
    await rf.onAssistantFinal("中间消息", false);
    rf.onToolStart("write");
    await rf.flushWindow();
    await rf.onAgentEnd();

    const bubbles = collectBubbles(calls);
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]).toBe("[🔧] [1] bash");
    expect(bubbles[1]).toBe("中间消息");
    expect(bubbles[2]).toBe("[🔧] [1] write");
  });

  it("活动→文本交错时每个文本与每段活动各成独立气泡", async () => {
    const { rf, calls } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-interleaved");
    rf.onAgentStart();
    rf.onToolStart("write");
    await rf.flushWindow();
    rf.onAssistantDelta("消息一", "");
    await rf.flushWindow();
    await rf.onAssistantFinal("消息一", false);
    rf.onToolStart("read");
    await rf.flushWindow();
    rf.onAssistantDelta("消息二", "");
    await rf.flushWindow();
    await rf.onAssistantFinal("消息二", false);
    rf.onToolStart("bash");
    await rf.flushWindow();
    rf.onAssistantDelta("最终回复", "");
    await rf.flushWindow();
    await rf.onAssistantFinal("最终回复", false);
    await rf.onAgentEnd();

    const bubbles = collectBubbles(calls);
    expect(bubbles).toHaveLength(6);
    expect(bubbles[1]).toBe("消息一");
    expect(bubbles[3]).toBe("消息二");
    expect(bubbles[5]).toBe("最终回复");
    expect(bubbles[0]).toBe("[🔧] [1] write");
    expect(bubbles[2]).toBe("[🔧] [1] read");
    expect(bubbles[4]).toBe("[🔧] [1] bash");
  });

  it("错误消息不走流接管，但会封口气泡", async () => {
    const { rf, calls } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-3");
    rf.onAgentStart();
    await rf.onAssistantDelta("部分输出", "");
    await rf.flushWindow();
    expect(await rf.onAssistantFinal("部分输出", true)).toBe(false);
    await rf.onAgentEnd();
    expect(calls.at(-1)?.input_state).toBe(DONE_STATE);
  });

  it("同一条消息定稿时的残余增量不切泡", async () => {
    const { rf, calls } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-4");
    rf.onAgentStart();
    await rf.onAssistantDelta("先行", "");
    await rf.flushWindow();
    await rf.onAssistantFinal("先行后补", false);
    await rf.onAgentEnd();
    expect(collectBubbles(calls)).toEqual(["先行后补"]);
  });

  it("无文本 assistant 消息不吞后续行组，且严格按事件顺序", async () => {
    const { rf, calls } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-textless");
    rf.onAgentStart();
    // Message 1: thinking + write (no text)
    rf.onAssistantDelta("", "思考 1");
    await rf.onAssistantFinal("", false);
    rf.onToolStart("write");
    await rf.flushWindow();
    // Message 2: thinking + text + read
    rf.onAssistantDelta("文件已写好", "思考 2");
    await rf.onAssistantFinal("文件已写好", false);
    rf.onToolStart("read");
    // Do not flush yet: simulate read and the next message's thinking
    // landing in the same 10s window.
    // Message 3: thinking + bash (no text)
    rf.onAssistantDelta("", "思考 3");
    await rf.onAssistantFinal("", false);
    rf.onToolStart("bash");
    await rf.flushWindow();
    // Message 4: final text
    rf.onAssistantDelta("最终回复", "");
    await rf.onAssistantFinal("最终回复", false);
    await rf.onAgentEnd();

    const bubbles = collectBubbles(calls);
    expect(bubbles).toHaveLength(4);
    expect((bubbles[0].match(/Thinking/g) ?? []).length).toBe(2);
    expect(bubbles[0]).toContain("[🔧] [1] write");
    expect(bubbles[1]).toBe("文件已写好");
    const readAt = bubbles[2].indexOf("[🔧] [1] read");
    const thinkingAt = bubbles[2].indexOf("[💭] Thinking...");
    const bashAt = bubbles[2].indexOf("[🔧] [1] bash");
    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(thinkingAt).toBeGreaterThan(readAt);
    expect(bashAt).toBeGreaterThan(thinkingAt);
    expect(bubbles[3]).toBe("最终回复");
  });

  it("诊断：每个新建流式气泡只计数一次", async () => {
    const { rf, budget } = makeRunHarness();
    budget.observeInbound("openid-u", "msg-count");
    rf.markQQTrigger("openid-u", "msg-count");
    rf.onAgentStart();
    rf.onToolStart("bash");
    await rf.flushWindow();
    rf.onAssistantDelta("hi", "");
    await rf.flushWindow();
    await rf.onAssistantFinal("hi", false);
    rf.onToolStart("read");
    await rf.flushWindow();
    await rf.onAgentEnd();

    const snapshot = budget.snapshot();
    expect(snapshot.streamBubbles).toBe(3);
    expect(snapshot.streamBubblesTotal).toBe(3);
  });
});
describe("QQ run state", () => {
  it("is active only for QQ-triggered runs", async () => {
    const { rf } = makeRunHarness();
    expect(rf.isQQRunActive()).toBe(false);

    rf.onAgentStart();
    expect(rf.isQQRunActive()).toBe(false);

    rf.markQQTrigger("openid-u", "msg-qq");
    rf.onAgentStart();
    expect(rf.isQQRunActive()).toBe(true);

    await rf.onAgentEnd();
    expect(rf.isQQRunActive()).toBe(false);
  });
});
