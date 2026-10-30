import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
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
import { configureLogger, log, previewForLog } from "./src/logger";
import { pruneUploadIndex, sessionUploadDir } from "./src/files";

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

  const startWithCredentials = async (ctx: ExtensionContext, creds: Credentials, allowedOpenid: string) => {
    const settings = getSettings(readConfig().config);
    configureLogger(settings.logLevel, join(ctx.cwd, ".pi", "pi-qq", "logs"));
    running?.stop();
    stateDetail = undefined;
    sessionCtx = ctx;
    const uploadDir = sessionUploadDir(ctx.cwd, ctx.sessionManager.getSessionId());
    const uploadIndex = await pruneUploadIndex(uploadDir);
    log.info("session", "starting bot", {
      appId: creds.appId,
      allowedOpenid,
      cwd: ctx.cwd,
      model: ctx.model?.name ?? null,
      markdownSupport: settings.markdownSupport,
      logLevel: settings.logLevel,
      uploadDir,
      indexedFiles: Object.keys(uploadIndex).length,
    });
    running = startBot({
      credentials: creds,
      allowedOpenid,
      markdownSupport: settings.markdownSupport,
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

  pi.on("session_start", async (_event, ctx) => {
    const { config, error } = readConfig();
    const settings = getSettings(config);
    configureLogger(settings.logLevel, join(ctx.cwd, ".pi", "pi-qq", "logs"));
    if (error) ctx.ui.notify(`pi-qq ${error}`, "error");

    const login = getLoginState();
    log.info("session", "started", {
      cwd: ctx.cwd,
      hasUI: ctx.hasUI,
      model: ctx.model?.name ?? null,
      logLevel: settings.logLevel,
      login: login ? { appId: login.credentials.appId, allowedOpenid: login.allowedOpenid } : null,
      configError: error ?? null,
    });
    if (login) {
      await startWithCredentials(ctx, login.credentials, login.allowedOpenid);
    } else if (ctx.hasUI) {
      ctx.ui.notify("pi-qq: run /qq-login to scan a QR code.", "warning");
    }
  });

  pi.on("session_shutdown", () => {
    log.info("session", "shutting down");
    stopIfRunning();
    sessionCtx = undefined;
    runFeedback.dispose();
  });

  // F7 run feedback: agent lifecycle / tool counts / text streaming.

  pi.on("agent_start", () => {
    log.info("agent", "run started");
    runFeedback.onAgentStart();
  });

  pi.on("agent_end", () => {
    log.info("agent", "run ended");
    void runFeedback.onAgentEnd();
  });

  pi.on("tool_execution_start", (event) => {
    log.debug("tool", "start", {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      args: previewForLog(event.args),
    });
    void runFeedback.onToolStart(event.toolName);
  });

  pi.on("tool_execution_end", (event) => {
    log.debug("tool", "end", {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      result: previewForLog(event.result),
    });
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

  // pi → QQ: assistant message relay (QQ-triggered runs only).

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || !running) return;

    const fromQQ = runFeedback.isQQRunActive();
    log.debug("pi", "assistant message ended", {
      fromQQ,
      stopReason: msg.stopReason,
      contentTypes: msg.content.map((block) => block.type),
      textPreview: previewForLog(
        msg.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n"),
      ),
    });
    if (!fromQQ) return;

    const { config } = readConfig();
    const settings = getSettings(config);
    const isError = msg.stopReason === "error";

    let text: string;
    if (isError) {
      text = `⚠️ Model error: ${msg.errorMessage ?? "unknown error"}`;
    } else {
      text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    if (!text) {
      log.debug("pi", "assistant message has no text", { isError });
      // Textless assistant messages also end the feedback turn: reset thinking state
      // and flush pending thinking rows so the next message does not swallow them.
      await runFeedback.onAssistantFinal("", isError);
      return;
    }

    // F7 stream takeover: stream frames render Markdown; send raw text so lengths match.
    const streamTookOver = await runFeedback.onAssistantFinal(text, isError);
    log.debug("pi", "stream takeover decision", { streamTookOver, isError, textPreview: previewForLog(text) });
    if (streamTookOver) return;

    const payload = settings.markdownSupport ? text : markdownToPlain(text);

    const bound = getLoginState()?.allowedOpenid;
    if (!bound) {
      log.warn("pi", "no bound user; reply skipped");
      ctx.ui.notify("pi-qq: no bound QQ user; skipping reply.", "warning");
      return;
    }

    log.info("pi", "sending reply", { textLength: text.length, payloadLength: payload.length });
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
      await startWithCredentials(ctx, credentials, result.userOpenid);
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
      ctx.ui.notify("pi-qq logged out.", "info");
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
