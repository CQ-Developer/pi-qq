import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureI18n } from "../../src/infra/i18n";
import { configureLogger, flushLogs, getLogFilePath, setLogGate } from "../../src/infra/file-logger";
import type { ReplyType } from "../../src/infra/reply-type";
import { RunFeedback } from "../../src/relay/run-stream-relay";
import { thinkingHeader } from "../../src/relay/stream-block-format";
import { ReplyBudget } from "../../src/quota/reply-quota";

beforeEach(() => configureI18n("zh-cn"));

afterEach(() => setLogGate(undefined));

const DONE_STATE = 10;
const THINKING_HEADER = thinkingHeader();

function makeRunHarness(
  options: {
    replyType?: ReplyType;
    failNext?: number;
    alwaysFail?: boolean;
    staleTarget?: boolean;
  } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];
  const warns: string[] = [];
  const fallbacks: string[] = [];
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
  budget.observeInbound("openid-u", "msg-1", options.staleTarget ? Date.now() - 10 * 60_000 : Date.now());
  const deps = {
    bot: () => bot,
    budget,
    getReplyType: () => options.replyType ?? "full",
    onWarn: (msg: string) => warns.push(msg),
    onFallbackReply: (text: string) => {
      fallbacks.push(text);
    },
  };
  return { rf: new RunFeedback(deps as never), calls, attempts, warns, fallbacks, budget };
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

function bashBubble(command: string, result: string): string {
  return `## 💻 bash\n\n\`\`\`bash\n${command}\n\`\`\`\n\n\`\`\`text\n${result}\n\`\`\`\n`;
}

function readBubble(path: string, result: string, language = "text"): string {
  return `## 📖 read\n\n\`${path}\`\n\n\`\`\`${language}\n${result}\n\`\`\`\n`;
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
      bashBubble("npm test", "12 passed"),
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
      `${THINKING_HEADER}${expectedThinking.repeat(12)}${"x".repeat(1000)}\n`,
      `${THINKING_HEADER}\n`,
      "done",
    ]);
    expect(calls.filter((call) => call.input_state === DONE_STATE)).toHaveLength(3);
    expect(new Set(calls.map((call) => call.stream_msg_id).filter(Boolean)).size).toBe(3);
    expect(budget.snapshot().streamBubblesTotal).toBe(3);
  });

  it("超过 12k 时在当前段的换行处切泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    let snapshot = "";
    for (let i = 0; i < 12; i++) {
      snapshot += "z".repeat(1000);
      rf.onAssistantDelta("", snapshot);
    }
    snapshot += "尾巴\n下一行";
    rf.onAssistantDelta("", snapshot);
    await rf.onAgentEnd();

    const bubbles = bubbleContents(calls);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].endsWith("尾巴\n")).toBe(true);
    expect(bubbles[1]).toContain("下一行");
  });

  it("超过 12k 但当前段没有换行时先不切，遇到换行再切", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    let snapshot = "";
    for (let i = 0; i < 13; i++) {
      snapshot += "q".repeat(1000);
      rf.onAssistantDelta("", snapshot);
    }
    snapshot += "\n新的一行";
    rf.onAssistantDelta("", snapshot);
    await rf.onAgentEnd();

    const bubbles = bubbleContents(calls);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].endsWith("q".repeat(1000) + "\n")).toBe(true);
    expect(bubbles[1]).toContain("新的一行");
  });

  it("代码块未闭合时不切分，闭合后的下一段才切", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    let snapshot = "前言\n```text\n";
    rf.onAssistantDelta("", snapshot);
    for (let i = 0; i < 13; i++) {
      snapshot += "y".repeat(1000) + "\n";
      rf.onAssistantDelta("", snapshot);
    }
    snapshot += "```\n闭合之后\n";
    rf.onAssistantDelta("", snapshot);
    snapshot += "再切一次\n后续内容";
    rf.onAssistantDelta("", snapshot);
    await rf.onAgentEnd();

    const bubbles = bubbleContents(calls);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]).toContain("后续内容");
  });

  it("思考代码块未闭合时在工具前补闭合围栏", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", "```\ncode");
    rf.onToolStart("bash", { command: "echo" });
    rf.onToolEnd("bash", false, "ok");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([THINKING_HEADER + "```\ncode\n```\n", bashBubble("echo", "ok")]);
  });

  it("工具调用与结果不拆泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onAssistantDelta("", `${"z".repeat(11900)}\n\n`);
    rf.onToolStart("bash", { command: `echo ${"y".repeat(180)}` });
    rf.onToolEnd("bash", false, "ok");
    await rf.onAgentEnd();

    expect(calls.filter((call) => call.input_state === DONE_STATE)).toHaveLength(2);
    expect(bubbleContents(calls)[1]).toContain("## 💻 bash");
    expect(bubbleContents(calls)[1]).toContain("```bash");
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
    expect(bubbleContents(calls).at(-1)).toContain("## 💻 bash");
    expect(bubbleContents(calls).at(-1)).toContain("```bash");
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
      bashBubble("one", "1"),
      bashBubble("two", "2"),
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

    expect(bubbleContents(calls)).toEqual([bashBubble("one", "1"), bashBubble("two", "2")]);
  });

  it("读取 SKILL.md 显示 skill 气泡并隐藏 read 内容", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("read", { path: "/home/chen/.pi/agent/skills/playwright-cli/SKILL.md" }, "skill-1");
    rf.onToolEnd("read", false, "---\nname: playwright-cli\n---\n", "skill-1");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual(["## 🧩 技能\n\n`playwright-cli`\n"]);
    expect(streamContent(calls)).not.toContain("SKILL.md");
    expect(streamContent(calls)).not.toContain("📖 read");
  });

  it("skill 之后的工具保持顺序", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("read", { file_path: "C:\\skills\\playwright-cli\\SKILL.md" }, "skill-1");
    rf.onToolEnd("read", false, "skill body", "skill-1");
    rf.onToolStart("bash", { command: "echo next" }, "bash-1");
    rf.onToolEnd("bash", false, "next", "bash-1");
    await rf.onAgentEnd();

    const bubbles = bubbleContents(calls);
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]).toBe("## 🧩 技能\n\n`playwright-cli`\n");
    expect(bubbles[1]).toContain("## 💻 bash");
    expect(bubbles[1]).toContain("```bash");
    expect(bubbles[1]).toContain("next");
    expect(streamContent(calls)).not.toContain("skill body");
  });

  it("顺序工具调用各自一个气泡", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "one" });
    rf.onToolEnd("bash", false, "1");
    rf.onToolStart("read", { path: "two" });
    rf.onToolEnd("read", false, "2");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([bashBubble("one", "1"), readBubble("two", "2")]);
  });

  it("read Markdown 结果使用 markdown 代码块", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("read", { path: "docs/a.md" });
    rf.onToolEnd("read", false, "# A\n\n正文");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([readBubble("docs/a.md", "# A\n\n正文", "markdown")]);
  });

  it("read Python/JSON 结果使用对应语言", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("read", { path: "src/a.py" }, "read-py");
    rf.onToolEnd("read", false, "print(1)", "read-py");
    rf.onToolStart("read", { path: "data/a.json" }, "read-json");
    rf.onToolEnd("read", false, '{"a":1}', "read-json");
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual([
      readBubble("src/a.py", "print(1)", "python"),
      readBubble("data/a.json", '{"a":1}', "json"),
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

    expect(bubbleContents(calls)).toEqual([bashBubble("one", "1"), readBubble("two", "2")]);
  });

  it("bash 命令含三反引号时使用更长围栏", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "echo ```x```" });
    rf.onToolEnd("bash", false, "ok");
    rf.onAssistantDelta("", "after");
    await rf.onAgentEnd();

    expect(streamContent(calls)).toContain("````bash\necho ```x```\n````");
    expect(streamContent(calls).match(/^```(?!`)/gm)).toHaveLength(2);
  });

  it("空文本结果不输出 wrapper JSON", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("read", { path: "empty.txt" });
    rf.onToolEnd("read", false, { content: [{ type: "text", text: "" }] });
    await rf.onAgentEnd();

    expect(streamContent(calls)).toContain("```text\n（无输出）\n```");
  });

  it("工具失败结果内联 ❌", async () => {
    const { rf, calls } = makeRunHarness();
    startRun(rf);
    rf.onToolStart("bash", { command: "false" });
    rf.onToolEnd("bash", true, "exit 1");
    await rf.onAgentEnd();
    expect(streamContent(calls)).toBe(bashBubble("false", "❌ exit 1"));
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
    expect(warns[0]).toContain("流式不可用");
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

describe("replyType simple", () => {
  it("只推 assistant 文本，不推思考与工具块", async () => {
    const { rf, calls } = makeRunHarness({ replyType: "simple" });
    startRun(rf);
    rf.onAssistantDelta("", "秘密思考");
    rf.onToolStart("bash", { command: "npm test" }, "call-1");
    rf.onToolEnd("bash", false, "12 passed", "call-1");
    rf.onAssistantDelta("答案", "");
    expect(await rf.onAssistantFinal("答案", false)).toBe(true);
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual(["答案"]);
    expect(streamContent(calls)).not.toContain("秘密思考");
    expect(streamContent(calls)).not.toContain("bash");
    expect(streamContent(calls)).not.toContain("12 passed");
  });

  it("多条 assistant 消息各自成泡", async () => {
    const { rf, calls } = makeRunHarness({ replyType: "simple" });
    startRun(rf);
    rf.onAssistantDelta("第一条", "");
    await rf.onAssistantFinal("第一条", false);
    rf.onAssistantDelta("第二条", "");
    await rf.onAssistantFinal("第二条", false);
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual(["第一条\n", "第二条"]);
  });

  it("工具调用消息不产生气泡，也不影响相邻文本分泡", async () => {
    const { rf, calls } = makeRunHarness({ replyType: "simple" });
    startRun(rf);
    rf.onAssistantDelta("第一条", "");
    await rf.onAssistantFinal("第一条", false);
    rf.onToolStart("bash", { command: "npm test" }, "call-1");
    rf.onToolEnd("bash", false, "ok", "call-1");
    rf.onAssistantDelta("第二条", "");
    await rf.onAssistantFinal("第二条", false);
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual(["第一条\n", "第二条"]);
  });

  it("工具未结束时文本立即推送，不延后", async () => {
    const { rf, calls } = makeRunHarness({ replyType: "simple" });
    startRun(rf);
    rf.onToolStart("bash", { command: "npm test" }, "call-1");
    rf.onAssistantDelta("先说一句", "");
    await rf.onAssistantFinal("先说一句", false);
    expect(streamContent(calls)).toBe("先说一句");
  });

  it("full 模式下同样的文本会延后到工具结束", async () => {
    const { rf, calls } = makeRunHarness({ replyType: "full" });
    startRun(rf);
    rf.onToolStart("bash", { command: "npm test" }, "call-1");
    rf.onAssistantDelta("先说一句", "");
    await rf.onAssistantFinal("先说一句", false);
    expect(streamContent(calls)).not.toContain("先说一句");

    rf.onToolEnd("bash", false, "done", "call-1");
    await rf.onAgentEnd();
    expect(streamContent(calls)).toContain("先说一句");
  });
});

describe("replyType last", () => {
  it("run 过程中不推送任何内容", async () => {
    const { rf, calls } = makeRunHarness({ replyType: "last" });
    startRun(rf);
    rf.onAssistantDelta("中间消息", "");
    expect(await rf.onAssistantFinal("中间消息", false)).toBe(true);
    rf.onToolStart("bash", { command: "npm test" }, "call-1");
    rf.onToolEnd("bash", false, "done", "call-1");
    expect(calls).toEqual([]);
  });

  it("run 结束时只推送最后一条 assistant 消息", async () => {
    const { rf, calls, fallbacks } = makeRunHarness({ replyType: "last" });
    startRun(rf);
    rf.onAssistantDelta("中间消息", "");
    await rf.onAssistantFinal("中间消息", false);
    rf.onAssistantDelta("最终答案", "");
    await rf.onAssistantFinal("最终答案", false);
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual(["最终答案"]);
    expect(fallbacks).toEqual([]);
  });

  it("最后一条消息没有文本时保留上一条有文本的消息", async () => {
    const { rf, calls } = makeRunHarness({ replyType: "last" });
    startRun(rf);
    rf.onAssistantDelta("有文本", "");
    await rf.onAssistantFinal("有文本", false);
    rf.onAssistantDelta("", "");
    await rf.onAssistantFinal("", false);
    await rf.onAgentEnd();

    expect(bubbleContents(calls)).toEqual(["有文本"]);
  });

  it("模型错误交给普通消息通道，不占用最后一条", async () => {
    const { rf, calls, fallbacks } = makeRunHarness({ replyType: "last" });
    startRun(rf);
    expect(await rf.onAssistantFinal("⚠️ Model error: boom", true)).toBe(false);
    await rf.onAgentEnd();

    expect(calls).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  it("流式失败时降级为普通消息", async () => {
    const { rf, calls, fallbacks } = makeRunHarness({ replyType: "last", alwaysFail: true });
    startRun(rf);
    rf.onAssistantDelta("最终答案", "");
    await rf.onAssistantFinal("最终答案", false);
    await rf.onAgentEnd();

    expect(calls).toEqual([]);
    expect(fallbacks).toEqual(["最终答案"]);
  });

  it("被动窗口过期时不走流式，直接降级为普通消息", async () => {
    const { rf, calls, fallbacks } = makeRunHarness({ replyType: "last", staleTarget: true });
    startRun(rf);
    rf.onAssistantDelta("最终答案", "");
    await rf.onAssistantFinal("最终答案", false);
    await rf.onAgentEnd();

    expect(calls).toEqual([]);
    expect(fallbacks).toEqual(["最终答案"]);
  });

  it("三种模式都保留最后一条完成文本", async () => {
    for (const replyType of ["full", "simple", "last"] as const) {
      const { rf } = makeRunHarness({ replyType });
      startRun(rf);
      rf.onAssistantDelta("完成文本", "");
      await rf.onAssistantFinal("完成文本", false);
      await rf.onAgentEnd();
      expect(rf.getLastMessage()).toBe("完成文本");
    }
  });

  it("交付结果在日志门关闭前落盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-relay-log-"));
    configureLogger("debug", dir);
    const { rf } = makeRunHarness({ replyType: "last" });
    setLogGate(() => rf.isQQRunActive());

    startRun(rf);
    rf.onAssistantDelta("最终答案", "");
    await rf.onAssistantFinal("最终答案", false);
    await rf.onAgentEnd();

    await flushLogs();
    const records = (await readFile(getLogFilePath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "run", msg: "last delivered", delivered: true, fallback: false }),
      ]),
    );
  });
});
