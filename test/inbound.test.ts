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
    sessionManager: { getSessionId: () => "session-test" },
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
  const run = (override: { content?: string; attachments?: unknown[] } = {}) =>
    handler(
      bot as never,
      {
        kind: "c2c",
        senderId: "openid-u",
        messageId: "msg-new",
        content: override.content ?? opts.content ?? "/new",
        attachments: override.attachments ?? opts.attachments ?? [],
      } as never,
    );
  return { run, sent, userMessages, triggers: () => triggers };
}

describe("inbound files", () => {
  const saved = { path: "/tmp/pi-qq-files/x.zip", originalName: "x.zip", size: 1234 };
  const attachment = { content_type: "application/zip", url: "https://example.com/x.zip", filename: "x.zip" };

  it("保存文件并把路径与用户消息一起注入提示词", async () => {
    let received: unknown[] | undefined;
    let receivedOptions: { uploadDir?: string } | undefined;
    const harness = makeInboundHarness(true, {
      content: "分析这个文件",
      attachments: [attachment],
      saveFiles: async (attachments, options) => {
        received = attachments as unknown[];
        receivedOptions = options as { uploadDir?: string };
        return { files: [saved], failures: [] };
      },
    });

    await harness.run();
    expect(received).toHaveLength(1);
    expect(receivedOptions?.uploadDir).toBe("/workspace/pi-qq-test/.pi/pi-qq/session-test/uploads");
    expect(harness.userMessages).toHaveLength(1);
    const content = harness.userMessages[0]?.content as string;
    expect(content).toContain(saved.path);
    expect(content).toContain("original name: x.zip");
    expect(content).toContain("User message:\n分析这个文件");
    expect(harness.triggers()).toBe(1);
  });

  it("纯文件消息不触发 run，等待下一条指令", async () => {
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [attachment],
      saveFiles: async () => ({ files: [saved], failures: [] }),
    });

    await harness.run();
    expect(harness.userMessages).toEqual([]);
    expect(harness.triggers()).toBe(0);

    await harness.run({ content: "处理这个文件", attachments: [] });
    const content = harness.userMessages[0]?.content as string;
    expect(content).toContain(saved.path);
    expect(content).toContain("User message:\n处理这个文件");
    expect(harness.triggers()).toBe(1);
  });
});

describe("inbound voice", () => {
  const voice = {
    content_type: "voice",
    url: "https://example.com/voice.amr",
    filename: "voice.amr",
    size: 3036,
    asr_refer_text: "测试。",
  };

  it("sends ASR text to pi without saving the voice file", async () => {
    let saved = false;
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [voice],
      saveFiles: async () => {
        saved = true;
        return { files: [], failures: [] };
      },
    });

    await harness.run();
    expect(harness.userMessages).toEqual([{ content: "测试。", options: { deliverAs: "steer" } }]);
    expect(harness.sent).toEqual([]);
    expect(harness.triggers()).toBe(1);
    expect(saved).toBe(false);
  });

  it("replies and skips the run when ASR is empty", async () => {
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [{ ...voice, asr_refer_text: "   " }],
    });

    await harness.run();
    expect(harness.sent).toEqual(["Could not transcribe this voice message; please resend or type it."]);
    expect(harness.userMessages).toEqual([]);
    expect(harness.triggers()).toBe(0);
  });
});

describe("inbound pending files", () => {
  const fileA = { content_type: "application/zip", url: "https://example.com/a.zip", filename: "a.zip" };
  const fileB = { content_type: "application/zip", url: "https://example.com/b.zip", filename: "b.zip" };
  const savedA = { path: "/tmp/a.zip", originalName: "a.zip", size: 10 };
  const savedB = { path: "/tmp/b.zip", originalName: "b.zip", size: 20 };

  it("waits after a file-only message and injects on the next text", async () => {
    let saveCalls = 0;
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [fileA],
      saveFiles: async () => {
        saveCalls += 1;
        return { files: [savedA], failures: [] };
      },
    });

    await harness.run();
    expect(harness.sent).toEqual([]);
    expect(harness.userMessages).toEqual([]);
    expect(harness.triggers()).toBe(0);

    await harness.run({ content: "分析这个文件", attachments: [] });
    expect(saveCalls).toBe(1);
    expect(harness.triggers()).toBe(1);
    expect(harness.userMessages).toHaveLength(1);
    const content = harness.userMessages[0]?.content as string;
    expect(content).toContain(savedA.path);
    expect(content).toContain("User message:\n分析这个文件");
  });

  it("merges multiple pending files into the next instruction", async () => {
    const savedByName = new Map([
      ["a.zip", savedA],
      ["b.zip", savedB],
    ]);
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [fileA],
      saveFiles: async (attachments) => ({
        files: (attachments as Array<{ filename: string }>).map((file) => savedByName.get(file.filename)!),
        failures: [],
      }),
    });

    await harness.run();
    await harness.run({ attachments: [fileB] });
    await harness.run({ content: "处理这两个文件", attachments: [] });

    expect(harness.triggers()).toBe(1);
    const content = harness.userMessages[0]?.content as string;
    expect(content).toContain(savedA.path);
    expect(content).toContain(savedB.path);
    expect(content).toContain("处理这两个文件");
  });

  it("uses a voice transcript as the instruction for pending files", async () => {
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [fileA],
      saveFiles: async () => ({ files: [savedA], failures: [] }),
    });

    await harness.run();
    await harness.run({
      attachments: [
        {
          content_type: "voice",
          url: "https://example.com/voice.amr",
          filename: "voice.amr",
          asr_refer_text: "处理这个文件",
        },
      ],
    });

    expect(harness.triggers()).toBe(1);
    const content = harness.userMessages[0]?.content as string;
    expect(content).toContain(savedA.path);
    expect(content).toContain("处理这个文件");
  });

  it("clears pending files on /new", async () => {
    const harness = makeInboundHarness(true, {
      content: "",
      attachments: [fileA],
      saveFiles: async () => ({ files: [savedA], failures: [] }),
    });

    await harness.run();
    await harness.run({ content: "/new", attachments: [] });
    await harness.run({ content: "分析", attachments: [] });

    const content = harness.userMessages.at(-1)?.content as string;
    expect(content).toBe("分析");
    expect(content).not.toContain(savedA.path);
    expect(harness.triggers()).toBe(1);
  });
});

describe("inbound /new", () => {
  it("idle 时回复并调用 qq-new 扩展命令，不触发 agent run", async () => {
    const harness = makeInboundHarness(true);
    await harness.run();
    expect(harness.sent).toEqual(["Resetting the session…"]);
    expect(harness.userMessages).toEqual([{ content: "/qq-new", options: { expandPromptTemplates: true } }]);
    expect(harness.triggers()).toBe(0);
  });

  it("busy 时拒绝重置", async () => {
    const harness = makeInboundHarness(false);
    await harness.run();
    expect(harness.sent).toEqual(["Task is running; use /stop before resetting."]);
    expect(harness.userMessages).toEqual([]);
  });
});
