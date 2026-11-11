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
