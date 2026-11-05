import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureLogger, flushLogs, getLogFilePath, log, setLogGate } from "../src/infra/file-logger";

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
  tools: Map<string, unknown>;
  state: { activeTools: string[] };
} {
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void> | void>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, unknown>();
  const state = { activeTools: ["read", "bash"] };
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) {
      commands.set(name, options.handler);
    },
    registerTool(tool: { name: string; defaultActive?: boolean }) {
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false) state.activeTools.push(tool.name);
    },
    getActiveTools() {
      return [...state.activeTools];
    },
    setActiveTools(names: string[]) {
      state.activeTools = [...names];
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, handlers, tools, state };
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
  setLogGate(undefined);
  feedback.isQQRunActive.mockReturnValue(false);
  configureLogger("silent");
  vi.restoreAllMocks();
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

  it("registers the media tool inactive and activates it after login", async () => {
    (globalThis as Record<string, unknown>)[LOGIN_STATE_KEY] = {
      credentials: { appId: "app", appSecret: "secret" },
      allowedOpenid: "openid-u",
    };
    bot.startBot.mockReturnValue({ bot: {}, stop: bot.stop });

    const { pi, commands, handlers, tools, state } = makePi();
    extension(pi);
    const ctx = makeCtx();

    expect(tools.has("qq_send_media")).toBe(true);
    expect(state.activeTools).not.toContain("qq_send_media");

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    expect(state.activeTools).toContain("qq_send_media");

    await commands.get("qq-logout")!("", ctx);
    expect(state.activeTools).not.toContain("qq_send_media");
  });

  it("qq-status reports the localized agent state", async () => {
    const { pi, commands } = makePi();
    extension(pi);
    const ctx = makeCtx();

    await commands.get("qq-status")!("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi-qq 状态"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("执行：已完成"), "info");
  });

  it("does not log local runs without qq login", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-index-log-"));
    configureLogger("debug", dir);

    const { pi, handlers } = makePi();
    extension(pi);
    const ctx = makeCtx();
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "hello" }],
    };

    await handlers.get("agent_start")!({}, ctx);
    await handlers.get("message_end")!({ message }, ctx);
    await handlers.get("agent_end")!({}, ctx);

    await flushLogs();
    await expect(readFile(getLogFilePath(), "utf8")).rejects.toThrow();
  });

  it("does not log local runs after qq login", async () => {
    (globalThis as Record<string, unknown>)[LOGIN_STATE_KEY] = {
      credentials: { appId: "app", appSecret: "secret" },
      allowedOpenid: "openid-u",
    };
    bot.startBot.mockReturnValue({ bot: {}, stop: bot.stop });

    const { pi, handlers } = makePi();
    extension(pi);
    const ctx = makeCtx();
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

    const dir = await mkdtemp(join(tmpdir(), "pi-qq-index-log-"));
    configureLogger("debug", dir);
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "local" }],
    };

    await handlers.get("agent_start")!({}, ctx);
    await handlers.get("message_end")!({ message }, ctx);
    await handlers.get("agent_end")!({}, ctx);

    await flushLogs();
    await expect(readFile(getLogFilePath(), "utf8")).rejects.toThrow();
  });

  it("logs qq-triggered runs", async () => {
    (globalThis as Record<string, unknown>)[LOGIN_STATE_KEY] = {
      credentials: { appId: "app", appSecret: "secret" },
      allowedOpenid: "openid-u",
    };
    feedback.isQQRunActive.mockReturnValue(true);

    const dir = await mkdtemp(join(tmpdir(), "pi-qq-index-log-"));
    configureLogger("debug", dir);
    const debugSpy = vi.spyOn(log, "debug");

    const { pi, handlers } = makePi();
    extension(pi);
    const ctx = makeCtx();
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "remote" }],
    };

    await handlers.get("agent_start")!({}, ctx);
    await handlers.get("message_end")!({ message }, ctx);
    await handlers.get("agent_end")!({}, ctx);

    expect(debugSpy).toHaveBeenCalledWith(
      "agent",
      "run state",
      expect.objectContaining({ phase: "start", fromQQ: true, hasLogin: true }),
    );
    expect(debugSpy).toHaveBeenCalledWith(
      "pi",
      "assistant message ended",
      expect.objectContaining({ fromQQ: true, hasLogin: true, textPreview: "remote" }),
    );

    await flushLogs();
    const records = (await readFile(getLogFilePath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "pi",
          msgKey: "log.assistantMessageEnded",
          textPreview: "remote",
        }),
      ]),
    );
  });

  it("does not write logs when level is silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-index-log-"));
    configureLogger("silent", dir);

    const { pi, handlers } = makePi();
    extension(pi);
    const ctx = makeCtx();
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "quiet" }],
    };

    await handlers.get("agent_start")!({}, ctx);
    await handlers.get("message_end")!({ message }, ctx);
    await handlers.get("agent_end")!({}, ctx);

    await flushLogs();
    await expect(readFile(getLogFilePath(), "utf8")).rejects.toThrow();
  });
});
