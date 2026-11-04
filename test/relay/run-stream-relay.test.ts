import { describe, expect, it } from "vitest";
import { RunFeedback } from "../../src/relay/run-stream-relay";
import { THINKING_HEADER } from "../../src/relay/stream-block-format";
import { ReplyBudget } from "../../src/quota/reply-quota";

const DONE_STATE = 10;

function makeRunHarness(options: { thinkingRelay?: boolean; failNext?: number; alwaysFail?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  let failuresLeft = options.failNext ?? 0;
  const api = {
    async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
      attempts.push({ ...req });
      if (options.alwaysFail || failuresLeft > 0) {
        if (failuresLeft > 0) failuresLeft -= 1;
        throw new Error("stream broke");
      }
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
    getThinkingRelay: () => options.thinkingRelay ?? true,
    onWarn: (msg: string) => warns.push(msg),
  };
  return { rf: new RunFeedback(deps as never), calls, attempts, warns, budget };
}

function streamContent(calls: Array<Record<string, unknown>>): string {
  return calls
    .filter((call) => call.input_state !== DONE_STATE)
    .map((call) => call.content_raw as string)
    .join("");
}

function bubbleContents(calls: Array<Record<string, unknown>>): string[] {
  const bubbles: string[] = [];
  let current = "";
  for (const call of calls) {
    if (call.input_state === DONE_STATE) {
      if (current) bubbles.push(current);
      current = "";
      continue;
    }
    if (!call.stream_msg_id && current) {
      bubbles.push(current);
      current = "";
    }
    current += call.content_raw as string;
  }
  if (current) bubbles.push(current);
  return bubbles;
}

function startRun(rf: RunFeedback, msgId = "msg-1"): void {
  rf.markQQTrigger("openid-u", msgId);
  rf.onAgentStart();
}

describe("RunFeedback 直推", () => {
  it("思考、工具、结果、文本按块切成多个气泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", "think 1\nthink 2");
    rf.onToolStart("bash", { command: "npm test" });
    rf.onToolEnd("bash", false, "12 passed");
    rf.onAssistantDelta("answer", "");
    expect(await rf.onAssistantFinal("answer", false)).toBe(true);
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([
      `${THINKING_HEADER}think 1\nthink 2\n`,
      "**💻 bash**\n\n`npm test`\n\n```text\n12 passed\n```\n",
      "answer",
    ]);
    expect(calls.filter((call) => call.input_state === DONE_STATE)).toHaveLength(3);
    expect(new Set(calls.map((call) => call.stream_msg_id).filter(Boolean)).size).toBe(3);
    expect(calls.at(-1)?.input_state).toBe(DONE_STATE);
  });

  it("思考中的空行保留", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", "line one\n\nline two");
    await rf.onAssistantFinal("", false);
    await rf.onAgentEnd();

    expect(streamContent(calls)).toBe(`${THINKING_HEADER}line one\n\nline two`);
  });

  it("思考快照按差量追加，不重复", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", "a");
    rf.onAssistantDelta("", "ab");
    rf.onAssistantDelta("", "abc");
    await rf.onAssistantFinal("", false);
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe(`${THINKING_HEADER}abc`);
  });

  it("文本快照只发送一次全文", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("前半", "");
    rf.onAssistantDelta("前半后半", "");
    expect(await rf.onAssistantFinal("前半后半", false)).toBe(true);
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe("前半后半");
  });

  it("保留纯空白的文本差量", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("a", "");
    rf.onAssistantDelta("a ", "");
    rf.onAssistantDelta("a b", "");
    expect(await rf.onAssistantFinal("a b", false)).toBe(true);
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe("a b");
  });

  it("保留代码块内的换行", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("```text\na", "");
    rf.onAssistantDelta("```text\na\n", "");
    rf.onAssistantDelta("```text\na\nb\n```", "");
    expect(await rf.onAssistantFinal("```text\na\nb\n```", false)).toBe(true);
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe("```text\na\nb\n```");
  });

  it("逐字符快照不丢空格与换行", async () => {
    const final = "```text\na\nb\n```\n\n**标题**\n\n- 第一项\n- 第二项\n";
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    for (let i = 1; i <= final.length; i++) {
      rf.onAssistantDelta(final.slice(0, i), "");
    }
    expect(await rf.onAssistantFinal(final, false)).toBe(true);
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe(final);
  });

  it("思考消息结束后文本另起气泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", "think");
    await rf.onAssistantFinal("", false);
    rf.onAssistantDelta("answer", "");
    await rf.onAssistantFinal("answer", false);
    await rf.onAgentEnd();
    expect(bubbleContents(calls)).toEqual([`${THINKING_HEADER}think\n`, "answer"]);
  });

  it("新的最终文本消息另起气泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("one", "");
    await rf.onAssistantFinal("one", false);
    rf.onAssistantDelta("two", "");
    await rf.onAssistantFinal("two", false);
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual(["one\n", "two"]);
  });

  it("thinkingRelay 关闭时不输出思考块", async () => {
    const { rf, calls } = makeRunHarness({ thinkingRelay: false });
    startRun(rf);
    rf.onAssistantDelta("answer", "secret");
    expect(await rf.onAssistantFinal("answer", false)).toBe(true);
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe("answer");
  });

  it("超过 12k 时在换行边界主动切泡", async () => {
    const { rf, calls, budget } = makeRunHarness();
    startRun(rf);
    const chunk = `${"x".repeat(1000)}\n\n`;
    let snapshot = "";
    for (let i = 0; i < 13; i++) {
      snapshot += chunk;
      rf.onAssistantDelta("", snapshot);
    }
    rf.onAssistantDelta("done", "");
    expect(await rf.onAssistantFinal("done", false)).toBe(true);
    await rf.onAgentEnd();

    const expectedThinking = "x".repeat(1000) + "\n\n";
    expect(bubbleContents(calls)).toEqual([
      `${THINKING_HEADER}${expectedThinking.repeat(12)}`,
      `${THINKING_HEADER}${expectedThinking}`,
      "done",
    ]);
    expect(calls.filter((call) => call.input_state === DONE_STATE)).toHaveLength(3);
    expect(new Set(calls.map((call) => call.stream_msg_id).filter(Boolean)).size).toBe(3);
    expect(budget.snapshot().streamBubblesTotal).toBe(3);
  });

  it("思考代码块未闭合时在工具前补闭合围栏", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", "```\ncode");
    rf.onToolStart("bash", { command: "echo" });
    rf.onToolEnd("bash", false, "ok");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([
      THINKING_HEADER + "```\ncode\n```\n",
      "**💻 bash**\n\n`echo`\n\n```text\nok\n```\n",
    ]);
  });

  it("工具调用与结果不拆泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", `${"z".repeat(11900)}\n\n`);
    rf.onToolStart("bash", { command: `echo ${"y".repeat(180)}` });
    rf.onToolEnd("bash", false, "ok");
    await rf.onAgentEnd();

    expect(calls.filter((call) => call.input_state === DONE_STATE)).toHaveLength(2);
    expect(bubbleContents(calls)[1]).toContain("**💻 bash**\n\n`echo");
    expect(bubbleContents(calls)[1]).toContain("ok");
  });

  it("超过 12k 时在工具前切泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", `${"q".repeat(12000)}\n\n`);
    rf.onToolStart("bash", { command: "echo" });
    rf.onToolEnd("bash", false, "ok");
    await rf.onAgentEnd();

    expect(calls.filter((call) => call.input_state === DONE_STATE)).toHaveLength(2);
    expect(bubbleContents(calls).at(-1)).toContain("**💻 bash**\n\n`echo");
  });

  it("工具未完成时后续思考延后，不打乱工具顺序", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "one" }, "call-1");
    rf.onToolStart("bash", { command: "two" }, "call-2");
    rf.onToolEnd("bash", false, "1", "call-1");
    rf.onAssistantDelta("", "after tools");
    rf.onToolEnd("bash", false, "2", "call-2");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([
      "**💻 bash**\n\n`one`\n\n```text\n1\n```\n",
      "**💻 bash**\n\n`two`\n\n```text\n2\n```\n",
      `${THINKING_HEADER}after tools`,
    ]);
  });

  it("模型错误后自动恢复的 run 继续沿用 QQ 目标", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", "before error");
    await rf.onAssistantFinal("⚠️ Model error: terminated", true);
    await rf.onAgentEnd();

    rf.onAgentStart();
    await rf.onAgentEnd();

    rf.onAgentStart();
    rf.onAssistantDelta("recovered output", "");
    expect(await rf.onAssistantFinal("recovered output", false)).toBe(true);
    await rf.onAgentEnd();

    expect(streamContent(calls)).toContain("recovered output");
  });

  it("waitForEnd 在 agent_end 收尾后 resolve", async () => {
    const { rf } = makeRunHarness();
    startRun(rf);
    let settled = false;
    const waiting = rf.waitForEnd().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await rf.onAgentEnd();
    await waiting;
    expect(settled).toBe(true);
  });

  it("getLastMessage 返回最近完成文本，repushCurrent 重新推送当前文本", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("partial", "");
    expect(rf.repushCurrent("openid-u", "msg-last")).toBe(true);

    await rf.onAssistantFinal("partial answer", false);
    await rf.onAgentEnd();
    expect(rf.getLastMessage()).toBe("partial answer");
    expect(streamContent(calls).match(/partial/g)?.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((call) => call.msg_id === "msg-last")).toBe(true);

    startRun(rf, "msg-2");
    expect(rf.repushCurrent("openid-u", "msg-last")).toBe(false);
    expect(rf.getLastMessage()).toBe("partial answer");
    await rf.onAgentEnd();
    expect(rf.getLastMessage()).toBe("partial answer");
  });

  it("流式熔断后仍保留 /last 可读取的文本", async () => {
    const { rf } = makeRunHarness({ alwaysFail: true });
    startRun(rf);
    rf.onAssistantDelta("hello", "");
    expect(rf.repushCurrent("openid-u", "msg-last")).toBe(true);
    await rf.onAssistantFinal("hello", false);
    await rf.onAgentEnd();
    expect(rf.getLastMessage()).toBe("hello");
  });

  it("repush 后下一条 assistant 消息不会丢失", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("first", "");
    await rf.onAssistantFinal("first", false);
    expect(rf.repushCurrent("openid-u", "msg-last")).toBe(true);

    rf.onAssistantDelta("second", "");
    await rf.onAssistantFinal("second", false);
    await rf.onAgentEnd();
    expect(streamContent(calls)).toContain("second");
    expect(rf.getLastMessage()).toBe("second");
  });

  it("dispose 清除待处理目标", () => {
    const { rf } = makeRunHarness();
    rf.markQQTrigger("openid-u", "msg-1");
    rf.dispose();
    rf.onAgentStart();
    expect(rf.isQQRunActive()).toBe(false);
  });

  it("同名并行工具按 toolCallId 归属结果", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "one" }, "call-1");
    rf.onToolStart("bash", { command: "two" }, "call-2");
    rf.onToolEnd("bash", false, "2", "call-2");
    rf.onToolEnd("bash", false, "1", "call-1");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([
      "**💻 bash**\n\n`one`\n\n```text\n1\n```\n",
      "**💻 bash**\n\n`two`\n\n```text\n2\n```\n",
    ]);
  });

  it("顺序工具调用各自一个气泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "one" });
    rf.onToolEnd("bash", false, "1");
    rf.onToolStart("read", { path: "two" });
    rf.onToolEnd("read", false, "2");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([
      "**💻 bash**\n\n`one`\n\n```text\n1\n```\n",
      "**📖 read**\n\n`two`\n\n```text\n2\n```\n",
    ]);
  });

  it("并行工具各自成泡，结果按工具归属", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "one" });
    rf.onToolStart("read", { path: "two" });
    rf.onToolEnd("read", false, "2");
    rf.onToolEnd("bash", false, "1");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([
      "**💻 bash**\n\n`one`\n\n```text\n1\n```\n",
      "**📖 read**\n\n`two`\n\n```text\n2\n```\n",
    ]);
  });

  it("工具行内联反引号不触发围栏", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "echo ```x```" });
    rf.onToolEnd("bash", false, "ok");
    rf.onAssistantDelta("", "after");
    await rf.onAgentEnd();

    expect(streamContent(calls).match(/^```(?!`)/gm)).toHaveLength(2);
  });

  it("空文本结果不输出 wrapper JSON", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("read", { path: "empty.txt" });
    rf.onToolEnd("read", false, { content: [{ type: "text", text: "" }] });
    await rf.onAgentEnd();

    expect(streamContent(calls)).toContain("```text\n(no output)\n```");
  });

  it("工具失败结果内联 ❌", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "false" });
    rf.onToolEnd("bash", true, "exit 1");
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe("**💻 bash**\n\n`false`\n\n```text\n❌ exit 1\n```\n");
  });

  it("首次失败后同泡续写，index 与缓冲保留", async () => {
    const { rf, calls, attempts, warns } = makeRunHarness({ failNext: 1 });
    startRun(rf);
    rf.onAssistantDelta("hello", "");
    expect(await rf.onAssistantFinal("hello", false)).toBe(true);
    await rf.onAgentEnd();

    expect(streamContent(calls)).toBe("hello");
    expect(attempts).toHaveLength(3);
    expect(attempts.map((attempt) => attempt.index)).toEqual([0, 1, 2]);
    expect(calls[0]?.index).toBe(1);
    expect(calls[0]?.stream_msg_id).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it("续写次数耗尽后熔断，最终文本不接管", async () => {
    const { rf, calls, warns } = makeRunHarness({ alwaysFail: true });
    startRun(rf);
    rf.onAssistantDelta("hello", "");
    expect(await rf.onAssistantFinal("hello", false)).toBe(false);
    await rf.onAgentEnd();

    expect(calls).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("Stream unavailable");
  });

  it("无 msgId 时放弃流式，交给消息路径", async () => {
    const { rf } = makeRunHarness();
    rf.onAgentStart();
    expect(rf.isQQRunActive()).toBe(false);
    rf.onAssistantDelta("hello", "");
    expect(await rf.onAssistantFinal("hello", false)).toBe(false);
    await rf.onAgentEnd();
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
