import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const feedback = vi.hoisted(() => ({
  dispose: vi.fn(),
  onAgentStart: vi.fn(),
  onAgentEnd: vi.fn(async () => {}),
  onAssistantDelta: vi.fn(),
  onAssistantFinal: vi.fn(async () => false),
  onToolStart: vi.fn(),
  onToolEnd: vi.fn(),
  markQQTrigger: vi.fn(),
  waitForEnd: vi.fn(async () => {}),
  cancelRecovery: vi.fn(),
  isQQRunActive: vi.fn(() => false),
  getLastMessage: vi.fn(() => undefined),
  repushCurrent: vi.fn(() => false),
}));

const bot = vi.hoisted(() => ({
  startBot: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../src/qq/qq-bot", () => ({
  startBot: bot.startBot,
}));

vi.mock("../src/relay/run-stream-relay", () => ({
  RunFeedback: class {
    dispose = feedback.dispose;
    onAgentStart = feedback.onAgentStart;
    onAgentEnd = feedback.onAgentEnd;
    onAssistantDelta = feedback.onAssistantDelta;
    onAssistantFinal = feedback.onAssistantFinal;
    onToolStart = feedback.onToolStart;
    onToolEnd = feedback.onToolEnd;
    markQQTrigger = feedback.markQQTrigger;
    waitForEnd = feedback.waitForEnd;
    cancelRecovery = feedback.cancelRecovery;
    isQQRunActive = feedback.isQQRunActive;
    getLastMessage = feedback.getLastMessage;
    repushCurrent = feedback.repushCurrent;
  },
}));

vi.mock("../src/infra/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/infra/settings")>();
  return {
    ...actual,
    readConfig: () => ({ config: {}, error: undefined }),
  };
});

import extension from "../index";

const LOGIN_STATE_KEY = "__piQQLoginState";

function makePi(): {
  pi: ExtensionAPI;
  commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>;
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
} {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers };
}

function makeCtx(): ExtensionContext {
  return {
    cwd: "/tmp/pi-qq-index-test",
    hasUI: false,
    mode: "tui",
    sessionManager: { getSessionId: () => "session-test" },
    model: { name: "test-model", input: ["text"] },
    ui: { notify: vi.fn() },
    getContextUsage: () => undefined,
    isIdle: () => true,
  } as unknown as ExtensionContext;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[LOGIN_STATE_KEY];
  vi.clearAllMocks();
});

describe("extension lifecycle", () => {
  it("starts the bot from login state and disposes the relay on logout", async () => {
    (globalThis as Record<string, unknown>)[LOGIN_STATE_KEY] = {
      credentials: { appId: "app", appSecret: "secret" },
      allowedOpenid: "openid-u",
    };
    bot.startBot.mockReturnValue({ bot: {}, stop: bot.stop });

    const { pi, commands, handlers } = makePi();
    extension(pi);
    const ctx = makeCtx();

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    expect(bot.startBot).toHaveBeenCalledWith(expect.objectContaining({ allowedOpenid: "openid-u" }));

    feedback.dispose.mockClear();
    await commands.get("qq-logout")!("", ctx);

    expect(bot.stop).toHaveBeenCalled();
    expect(feedback.dispose).toHaveBeenCalled();
    expect((globalThis as Record<string, unknown>)[LOGIN_STATE_KEY]).toBeUndefined();
  });

  it("qq-status reports the localized agent state", async () => {
    const { pi, commands } = makePi();
    extension(pi);
    const ctx = makeCtx();

    await commands.get("qq-status")!("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi-qq 状态"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("执行：已完成"), "info");
  });
});
