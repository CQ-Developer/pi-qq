import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings, readConfig, type Credentials } from "./src/config";
import { startBot, type BotState, type RunningBot } from "./src/bot";
import { runQrLogin } from "./src/login";
import { createInboundHandler } from "./src/inbound";
import { markdownToPlain, sendReply } from "./src/outbound";
import { ReplyBudget } from "./src/reply-budget";
import { RunFeedback } from "./src/run-feedback";
import { AppendStream } from "./src/append-stream";
import { formatTokenCount } from "./src/format";
import { formatBudgetStatus } from "./src/budget-status";

/**
 * pi-qq extension entry.
 * QR login only; credentials live in process memory and are never persisted.
 */

/** In-memory login state; survives extension reload/session replacement in one process. */
interface LoginState {
  credentials: Credentials;
  allowedOpenid: string;
}

const LOGIN_STATE_KEY = "__piQQLoginState";
type GlobalWithLogin = typeof globalThis & { [LOGIN_STATE_KEY]?: LoginState };

function getLoginState(): LoginState | undefined {
  return (globalThis as GlobalWithLogin)[LOGIN_STATE_KEY];
}

function setLoginState(state: LoginState | undefined): void {
  const store = globalThis as GlobalWithLogin;
  if (state) store[LOGIN_STATE_KEY] = state;
  else delete store[LOGIN_STATE_KEY];
}

/** Session-level runtime state; rebuilt by a new runtime after reload/session switch. */
let running: RunningBot | undefined;
let lastState: BotState = "stopped";
let stateDetail: string | undefined;
let sessionCtx: ExtensionContext | undefined;
const budget = new ReplyBudget();
const runFeedback = new RunFeedback({
  bot: () => running?.bot,
  budget,
  boundOpenid: () => getLoginState()?.allowedOpenid,
  getHeartbeatMinutes: () => getSettings(readConfig().config).heartbeatMinutes,
  getHeartbeatMaxMessages: () => getSettings(readConfig().config).heartbeatMaxMessages,
  getStreamRelay: () => getSettings(readConfig().config).streamRelay,
  getStreamFlushMs: () => getSettings(readConfig().config).streamFlushMs,
  getDebug: () => getSettings(readConfig().config).debug,
  makeChannel: () => ({
    budget,
    boundOpenid: getLoginState()?.allowedOpenid ?? "",
    onWarn: (msg) => sessionCtx?.ui.notify(`pi-qq ${msg}`, "warning"),
  }),
  onWarn: (msg) => sessionCtx?.ui.notify(`pi-qq ${msg}`, "warning"),
});

const fmtTokens = (n: number | null): string => (n === null ? "unknown" : formatTokenCount(n));

export default function (pi: ExtensionAPI) {
  const maskAppId = (appId: string) => `${appId.slice(0, 4)}****`;

  // Live settings reader (binding/settings changes apply immediately).

  const getAllowedOpenid = () => getLoginState()?.allowedOpenid;
  const getBoundOpenid = getAllowedOpenid;
  const getDeliverAs = () => getSettings(readConfig().config).deliverAs;

  const onWarn = (ctx: ExtensionContext) => (msg: string) => ctx.ui.notify(`pi-qq ${msg}`, "warning");

  const getStatusLines = (): string[] => {
    const login = getLoginState();
    const usage = sessionCtx?.getContextUsage();
    const model = sessionCtx?.model;
    return [
      "pi-qq status",
      `Login: ${login ? `QR login, in memory (AppID ${maskAppId(login.credentials.appId)})` : "not logged in"}`,
      `Connection: ${lastState}${stateDetail ? ` (${stateDetail})` : ""}`,
      `Model: ${model?.name ?? "none"}`,
      usage
        ? `Context: ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)} (${usage.percent?.toFixed(1) ?? "?"}%)`
        : "Context: unknown",
      `Bound user: ${login?.allowedOpenid ?? "none"}`,
      `Settings: ~/.pi/agent/pi-qq.json`,
    ];
  };

  // —— Login and connection ——

  const startWithCredentials = (ctx: ExtensionContext, creds: Credentials, allowedOpenid: string) => {
    const settings = getSettings(readConfig().config);
    running?.stop();
    stateDetail = undefined;
    sessionCtx = ctx;
    running = startBot({
      credentials: creds,
      allowedOpenid,
      markdownSupport: settings.markdownSupport,
      debug: settings.debug,
      onMessage: createInboundHandler({
        pi,
        ctx,
        budget,
        getAllowedOpenid,
        getBoundOpenid,
        getDeliverAs,
        getImageMaxSize: () => getSettings(readConfig().config).imageMaxSize,
        getFileMaxSize: () => getSettings(readConfig().config).fileMaxSize,
        getStatusLines,
        onWarn: onWarn(ctx),
        markQQTrigger: (openid, msgId) => runFeedback.markQQTrigger(openid, msgId),
      }),
      onStateChange: (state, detail) => {
        lastState = state;
        stateDetail = detail;
        if (state === "connected") ctx.ui.notify("pi-qq connected", "info");
        else if (state === "blocked") ctx.ui.notify(`pi-qq ${detail ?? "connection blocked"}`, "error");
        else if (state === "stopped" && detail) ctx.ui.notify(`pi-qq ${detail}`, "warning");
      },
      onRecoverableError: () => {
        // Recoverable errors are handled by the SDK reconnect loop.
      },
    });
  };

  const stopIfRunning = () => {
    running?.stop();
    running = undefined;
    lastState = "stopped";
    stateDetail = undefined;
  };

  // —— Lifecycle ——

  pi.on("session_start", (_event, ctx) => {
    const { error } = readConfig();
    if (error) ctx.ui.notify(`pi-qq ${error}`, "error");

    const login = getLoginState();
    if (login) {
      startWithCredentials(ctx, login.credentials, login.allowedOpenid);
    } else if (ctx.hasUI) {
      ctx.ui.notify("pi-qq: run /qq-login to scan a QR code.", "warning");
    }
  });

  pi.on("session_shutdown", () => {
    stopIfRunning();
    sessionCtx = undefined;
    runFeedback.dispose();
  });

  // F7 run feedback: agent lifecycle / tool counts / text streaming.

  pi.on("agent_start", () => {
    runFeedback.onAgentStart();
  });

  pi.on("agent_end", () => {
    void runFeedback.onAgentEnd();
  });

  pi.on("tool_execution_start", (event) => {
    void runFeedback.onToolStart(event.toolName);
  });

  pi.on("tool_execution_end", (event) => {
    runFeedback.onToolEnd(event.toolName, event.isError);
  });

  pi.on("message_update", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    const snapshot = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const thinking = msg.content
      .filter((b) => b.type === "thinking")
      .map((b) => b.thinking)
      .join("");
    void runFeedback.onAssistantDelta(snapshot, thinking);
  });

  // pi → QQ: assistant message relay (non-streaming path + F7 stream takeover).

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || !running) return;

    const { config } = readConfig();
    const settings = getSettings(config);
    const isError = msg.stopReason === "error";

    let text: string;
    if (isError) {
      text = `⚠️ 模型调用失败：${msg.errorMessage ?? "未知错误"}`;
    } else {
      text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    if (!text) {
      // Textless assistant messages also end the feedback turn: reset thinking state
      // and flush pending thinking rows so the next message does not swallow them.
      await runFeedback.onAssistantFinal("", isError);
      return;
    }

    // F7 stream takeover: stream frames render Markdown; send raw text so lengths match.
    if (await runFeedback.onAssistantFinal(text, isError)) return;

    const payload = settings.markdownSupport ? text : markdownToPlain(text);

    const bound = getLoginState()?.allowedOpenid;
    if (!bound) {
      ctx.ui.notify("pi-qq: no bound QQ user; skipping reply.", "warning");
      return;
    }

    void sendReply(running.bot, payload, {
      budget,
      boundOpenid: bound,
      onWarn: onWarn(ctx),
    });
  });

  // —— Commands ——

  pi.registerCommand("qq-login", {
    description: "pi-qq: log in with a QR code and bind the scanning QQ user",
    handler: async (_args, ctx) => {
      const { error } = readConfig();
      if (error) ctx.ui.notify(`pi-qq ${error}`, "error");

      stopIfRunning();
      setLoginState(undefined);
      const result = await runQrLogin(ctx);
      if (!result) return;
      if (!result.userOpenid) {
        ctx.ui.notify("pi-qq: QR login did not return a user openid; cannot bind.", "error");
        return;
      }

      const credentials: Credentials = { appId: result.appId, appSecret: result.appSecret };
      setLoginState({ credentials, allowedOpenid: result.userOpenid });
      startWithCredentials(ctx, credentials, result.userOpenid);
    },
  });

  pi.registerCommand("qq-status", {
    description: "pi-qq: show login, connection, and bound QQ user",
    handler: async (_args, ctx) => {
      ctx.ui.notify(getStatusLines().join("\n"), "info");
    },
  });

  pi.registerCommand("qq-test-budget", {
    description: "pi-qq: show passive reply budget, stream bubbles, and last inbound target",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatBudgetStatus(budget.snapshot(), budget.lastTarget).join("\n"), "info");
    },
  });

  pi.registerCommand("qq-logout", {
    description: "pi-qq: log out and clear in-memory credentials",
    handler: async (_args, ctx) => {
      stopIfRunning();
      setLoginState(undefined);
      ctx.ui.notify("pi-qq logged out. Credentials cleared from memory; run /qq-login to scan again.", "info");
    },
  });

  pi.registerCommand("qq-new", {
    description: "pi-qq: reset the current session (used by QQ /new)",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("pi-qq: the agent is busy; run /stop before resetting the session.", "warning");
        return;
      }
      const { cancelled } = await ctx.newSession();
      if (cancelled) ctx.ui.notify("pi-qq: session reset cancelled.", "warning");
    },
  });

  // —— Diagnostic commands ——

  const diagTarget = () => {
    const last = budget.lastTarget;
    if (last) return { scope: "c2c" as const, targetId: last.openid, msgId: last.msgId };
    const bound = getLoginState()?.allowedOpenid;
    return bound ? { scope: "c2c" as const, targetId: bound } : undefined;
  };

  pi.registerCommand("qq-test-md", {
    description: "pi-qq: send a Markdown message to verify QQ C2C Markdown rendering",
    handler: async (args, ctx) => {
      if (!running) {
        ctx.ui.notify("pi-qq is not connected.", "warning");
        return;
      }
      const target = diagTarget();
      if (!target) {
        ctx.ui.notify("pi-qq: no send target. Send a QQ message first.", "warning");
        return;
      }
      const content = args?.trim() || "**Markdown test**\n# Heading\n- Item one\n- Item two\n[Link](https://qq.com)";
      try {
        await running.bot.sendMarkdown(target, content);
        ctx.ui.notify("Markdown test sent. Check whether QQ renders it as rich text.", "info");
      } catch (err) {
        ctx.ui.notify(`Markdown send failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("qq-test-stream", {
    description: "pi-qq: run a streamed timeline diagnostic (thinking/tools/text)",
    handler: async (_args, ctx) => {
      if (!running) {
        ctx.ui.notify("pi-qq is not connected.", "warning");
        return;
      }
      const last = budget.lastTarget;
      if (!last) {
        ctx.ui.notify("pi-qq: send a QQ message first (streaming needs a msgId).", "warning");
        return;
      }
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        const stream = new AppendStream(running.bot.messageApi, running.bot.getCredentials(), last.openid, last.msgId);
        await stream.append("[💭] Thinking...\n[🔧] [3] bash\n[🔧] [2] read\n");
        await sleep(1200);
        await stream.append("\n**Intermediate message**: first-turn reply.\n");
        await sleep(1200);
        await stream.append("[🔧] [1] edit\n");
        await sleep(800);
        await stream.append("\n**Final reply** (streamed append)");
        let doneNote = "DONE succeeded";
        try {
          await stream.done();
        } catch (doneErr) {
          doneNote = `DONE rejected: ${(doneErr as Error).message}`;
        }
        ctx.ui.notify(`Stream timeline test: frames sent, ${doneNote}. Check the QQ activity timeline.`, "info");
      } catch (err) {
        ctx.ui.notify(`Stream timeline test failed: ${(err as Error).message}`, "error");
      }
    },
  });
}
