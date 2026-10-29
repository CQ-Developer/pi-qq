import { describe, expect, it } from "vitest";
import { createInboundHandler } from "../src/inbound";
import { ReplyBudget } from "../src/reply-budget";

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

describe("inbound /new", () => {
  it("idle 时回复并调用 qq-new 扩展命令，不触发 agent run", async () => {
    const harness = makeInboundHarness(true);
    await harness.run();
    expect(harness.sent).toEqual(["正在重置会话…"]);
    expect(harness.userMessages).toEqual([{ content: "/qq-new", options: { expandPromptTemplates: true } }]);
    expect(harness.triggers()).toBe(0);
  });

  it("busy 时拒绝重置", async () => {
    const harness = makeInboundHarness(false);
    await harness.run();
    expect(harness.sent).toEqual(["任务运行中，请先 /stop 再重置会话"]);
    expect(harness.userMessages).toEqual([]);
  });
});
