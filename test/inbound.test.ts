import { describe, expect, it } from "vitest";
import { createInboundHandler } from "../src/inbound";
import { ReplyBudget } from "../src/reply-budget";

function makeInboundHarness(
  isIdle: boolean,
  opts: {
    content?: string;
    attachments?: unknown[];
    modelInput?: string[];
    saveFiles?: (attachments: unknown, options: unknown) => Promise<unknown>;
  } = {},
) {
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
    cwd: "/workspace/pi-qq-test",
    model: { input: opts.modelInput ?? ["text"] },
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
    getFileMaxSize: () => 50 * 1024 * 1024,
    saveFiles: opts.saveFiles,
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
        content: opts.content ?? "/new",
        attachments: opts.attachments ?? [],
      } as never,
    );
  return { run, sent, userMessages, triggers: () => triggers };
}

describe("inbound files", () => {
  const saved = { path: "/tmp/pi-qq-files/x.zip", originalName: "x.zip", size: 1234 };
  const attachment = { content_type: "application/zip", url: "https://example.com/x.zip", filename: "x.zip" };

  it("保存文件并把路径与用户消息一起注入提示词", async () => {
    let received: unknown[] | undefined;
    let receivedOptions: { baseDir?: string; dirKey?: string } | undefined;
    const harness = makeInboundHarness(true, {
      content: "分析这个文件",
      attachments: [attachment],
      saveFiles: async (attachments, options) => {
        received = attachments as unknown[];
        receivedOptions = options as { baseDir?: string; dirKey?: string };
        return { files: [saved], failures: [] };
      },
    });

    await harness.run();
    expect(received).toHaveLength(1);
    expect(receivedOptions?.baseDir).toBe("/workspace/pi-qq-test/.pi/pi-qq");
    expect(receivedOptions?.dirKey).toBe("msg-new");
    expect(harness.userMessages).toHaveLength(1);
    const content = harness.userMessages[0]?.content as string;
    expect(content).toContain(saved.path);
    expect(content).toContain("原始名：x.zip");
    expect(content).toContain("用户消息：\n分析这个文件");
    expect(harness.triggers()).toBe(1);
  });

  it("纯文件消息也会触发 run，提示词只含文件块", async () => {
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [attachment],
      saveFiles: async () => ({ files: [saved], failures: [] }),
    });

    await harness.run();
    const content = harness.userMessages[0]?.content as string;
    expect(content).toContain(saved.path);
    expect(content).not.toContain("用户消息：");
    expect(harness.triggers()).toBe(1);
  });
});

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
