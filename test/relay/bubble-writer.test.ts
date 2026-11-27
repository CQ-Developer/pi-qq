import { describe, expect, it } from "vitest";
import { BubbleWriter } from "../../src/relay/bubble-writer";
import { ReplyBudget } from "../../src/quota/reply-quota";

function makeWriter(failures = 0) {
  const calls: Array<Record<string, unknown>> = [];
  let failuresLeft = failures;
  const api = {
    async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
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
  budget.observeInbound("openid-u", "msg-1");
  const writer = new BubbleWriter({
    bot: () => bot as never,
    budget,
    openid: "openid-u",
    msgId: "msg-1",
    startedAt: Date.now(),
    onWarn: () => {},
  });
  return { writer, calls };
}

function content(calls: Array<Record<string, unknown>>): string {
  return calls.map((call) => call.content_raw as string).join("");
}

describe("BubbleWriter restartSnapshot", () => {
  it("pushes thinking, tool, and text blocks to a new target", async () => {
    const { writer, calls } = makeWriter();
    writer.restartSnapshot(
      [
        { kind: "thinking", text: "thinking" },
        {
          kind: "tool",
          tool: { name: "bash", args: { command: "echo hi" }, result: { isError: false, result: "hi" } },
        },
        { kind: "text", text: "answer" },
      ],
      { openid: "openid-u", msgId: "msg-2" },
    );
    await writer.whenIdle();
    await writer.flush();

    expect(calls[0]?.msg_id).toBe("msg-2");
    expect(content(calls)).toContain("## 💭");
    expect(content(calls)).toContain("## 💻 bash");
    expect(content(calls)).toContain("hi");
    expect(content(calls)).toContain("answer");
  });

  it("revives a dead writer and updates the target", async () => {
    const { writer, calls } = makeWriter(3);
    writer.pushText("before");
    await expect(writer.flush()).resolves.toBe(false);
    expect(writer.dead).toBe(true);

    writer.restartSnapshot([{ kind: "text", text: "after" }], { openid: "openid-u", msgId: "msg-2" });
    await writer.whenIdle();
    await expect(writer.flush()).resolves.toBe(true);

    expect(writer.dead).toBe(false);
    expect(content(calls)).toBe("after");
    expect(calls.every((call) => call.msg_id === "msg-2")).toBe(true);
  });
});

describe("BubbleWriter active stream", () => {
  it("reports an active stream until dispose", async () => {
    const { writer } = makeWriter();
    expect(writer.hasActiveStream).toBe(false);

    writer.pushText("hello");
    await writer.whenIdle();
    expect(writer.hasActiveStream).toBe(true);

    writer.dispose();
    expect(writer.hasActiveStream).toBe(false);
  });
});

describe("BubbleWriter expired stream", () => {
  it("40034020 在已有 stream_msg_id 时新开流并重放未确认缓冲", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const api = {
      async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
        attempts += 1;
        if (attempts === 2) {
          throw Object.assign(new Error("同一流式消息发送超过时间限制"), { bizCode: 40034020 });
        }
        calls.push({ ...req });
        return { id: `sm-${attempts}` };
      },
    };
    const bot = {
      messageApi: api,
      getCredentials: () => ({}),
      sendTyping: async () => {},
    };
    const budget = new ReplyBudget();
    budget.observeInbound("openid-u", "msg-1");
    const writer = new BubbleWriter({
      bot: () => bot as never,
      budget,
      openid: "openid-u",
      msgId: "msg-1",
      startedAt: Date.now(),
      onWarn: () => {},
    });

    writer.pushText("hello");
    await writer.whenIdle();
    writer.pushText("world");
    await expect(writer.flush()).resolves.toBe(true);

    expect(attempts).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.content_raw).toBe("hello");
    expect(calls[1]?.content_raw).toBe("world");
    expect(calls[1]?.msg_seq).not.toBe(calls[0]?.msg_seq);
    expect(calls[1]?.index).toBe(0);
    expect(calls[1]?.stream_msg_id).toBeUndefined();
    expect(writer.dead).toBe(false);
  });
});

describe("BubbleWriter DONE failure", () => {
  it("returns false when DONE is rejected", async () => {
    let doneAttempts = 0;
    const api = {
      async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
        if (req.input_state === 10) {
          doneAttempts += 1;
          throw new Error("done failed");
        }
        return { id: "sm-1" };
      },
    };
    const bot = {
      messageApi: api,
      getCredentials: () => ({}),
      sendTyping: async () => {},
    };
    const budget = new ReplyBudget();
    budget.observeInbound("openid-u", "msg-1");
    const writer = new BubbleWriter({
      bot: () => bot as never,
      budget,
      openid: "openid-u",
      msgId: "msg-1",
      startedAt: Date.now(),
      onWarn: () => {},
    });

    writer.pushText("hello");
    await writer.flush();
    await expect(writer.done()).resolves.toBe(false);
    expect(doneAttempts).toBe(1);
  });
});

describe("BubbleWriter ended stream", () => {
  it("40034019 在已有 stream_msg_id 时新开流并重放未确认缓冲", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const api = {
      async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
        attempts += 1;
        if (attempts === 2) {
          throw Object.assign(new Error("流式引导已经结束，不能继续发送"), { bizCode: 40034019 });
        }
        calls.push({ ...req });
        return { id: `sm-${attempts}` };
      },
    };
    const bot = {
      messageApi: api,
      getCredentials: () => ({}),
      sendTyping: async () => {},
    };
    const budget = new ReplyBudget();
    budget.observeInbound("openid-u", "msg-1");
    const writer = new BubbleWriter({
      bot: () => bot as never,
      budget,
      openid: "openid-u",
      msgId: "msg-1",
      startedAt: Date.now(),
      onWarn: () => {},
    });

    writer.pushText("hello");
    await writer.whenIdle();
    writer.pushText("world");
    await expect(writer.flush()).resolves.toBe(true);

    expect(attempts).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.content_raw).toBe("hello");
    expect(calls[1]?.content_raw).toBe("world");
    expect(calls[1]?.msg_seq).not.toBe(calls[0]?.msg_seq);
    expect(calls[1]?.index).toBe(0);
    expect(calls[1]?.stream_msg_id).toBeUndefined();
    expect(writer.dead).toBe(false);
  });
});
