import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { getSettings, readConfig, type Credentials, type ResolvedSettings } from "./src/infra/settings";
import { startBot, type BotState, type RunningBot } from "./src/qq/qq-bot";
import { runQrLogin, type QrLoginResult } from "./src/qq/qr-login";
import { createInboundHandler } from "./src/qq/qq-message-handler";
import { registerQQDiagnostics } from "./src/qq/qq-diagnostics";
import { markdownToPlain, sendReply } from "./src/qq/reply-sender";
import { ReplyBudget } from "./src/quota/reply-quota";
import { RunFeedback } from "./src/relay/run-stream-relay";
import { formatTokenCount } from "./src/infra/display-format";
import { configureLogger, log, previewForLog } from "./src/infra/file-logger";
import { pruneUploadIndex, sessionUploadDir } from "./src/attachments/file-attachments";

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

let running: RunningBot | undefined;
let lastState: BotState = "stopped";
let stateDetail: string | undefined;
let sessionCtx: ExtensionContext | undefined;
let activeSettings: ResolvedSettings = getSettings({});
const budget = new ReplyBudget();
const runFeedback = new RunFeedback({
  bot: () => running?.bot,
  budget,
  getThinkingRelay: () => activeSettings.thinkingRelay,
  onWarn: (msg) => sessionCtx?.ui.notify(`pi-qq ${msg}`, "warning"),
});

const fmtTokens = (n: number | null): string => (n === null ? "unknown" : formatTokenCount(n));

export default function (pi: ExtensionAPI) {
  const maskAppId = (appId: string) => `${appId.slice(0, 4)}****`;

  const getAllowedOpenid = () => getLoginState()?.allowedOpenid;
  const getDeliverAs = () => activeSettings.deliverAs;

  const onWarn = (ctx: ExtensionContext) => (msg: string) => ctx.ui.notify(`pi-qq ${msg}`, "warning");

  const applyConfig = (ctx: ExtensionContext) => {
    const { config, error } = readConfig();
    activeSettings = getSettings(config);
    if (error) ctx.ui.notify(`pi-qq ${error}`, "error");
    return { settings: activeSettings, error };
  };

  const getStatusLines = (ctx: ExtensionContext | undefined = sessionCtx): string[] => {
    const login = getLoginState();
    const usage = ctx?.getContextUsage();
    const model = ctx?.model;
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

  const stopIfRunning = () => {
    running?.stop();
    running = undefined;
    lastState = "stopped";
    stateDetail = undefined;
    sessionCtx = undefined;
    runFeedback.dispose();
  };

  const startWithCredentials = async (ctx: ExtensionContext, creds: Credentials, allowedOpenid: string) => {
    const settings = activeSettings;
    configureLogger(settings.logLevel, join(ctx.cwd, ".pi", "pi-qq", "logs"));
    stopIfRunning();
    stateDetail = undefined;
    sessionCtx = ctx;
    const uploadDir = sessionUploadDir(ctx.cwd, ctx.sessionManager.getSessionId());
    const uploadIndex = await pruneUploadIndex(uploadDir);
    log.info("session", "starting bot", {
      appId: creds.appId,
      allowedOpenid,
      cwd: ctx.cwd,
      model: ctx.model?.name ?? null,
      logLevel: settings.logLevel,
      uploadDir,
      indexedFiles: Object.keys(uploadIndex).length,
    });
    running = startBot({
      credentials: creds,
      allowedOpenid,
      onMessage: createInboundHandler({
        pi,
        ctx,
        budget,
        getAllowedOpenid,
        getDeliverAs,
        getFileMaxSize: () => activeSettings.fileMaxSize,
        getStatusLines,
        onWarn: onWarn(ctx),
        markQQTrigger: (openid, msgId) => runFeedback.markQQTrigger(openid, msgId),
        waitForEnd: () => runFeedback.waitForEnd(),
        onStop: () => runFeedback.cancelRecovery(),
      }),
      onStateChange: (state, detail) => {
        lastState = state;
        stateDetail = detail;
        if (state === "connected") ctx.ui.notify("pi-qq connected", "info");
        else if (state === "blocked") ctx.ui.notify(`pi-qq ${detail ?? "connection blocked"}`, "error");
        else if (state === "stopped" && detail) ctx.ui.notify(`pi-qq ${detail}`, "warning");
      },
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const { settings, error } = applyConfig(ctx);
    configureLogger(settings.logLevel, join(ctx.cwd, ".pi", "pi-qq", "logs"));

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
  });

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
    void runFeedback.onToolStart(event.toolName, event.args, event.toolCallId);
  });

  pi.on("tool_execution_end", (event) => {
    log.debug("tool", "end", {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      result: previewForLog(event.result),
    });
    runFeedback.onToolEnd(event.toolName, event.isError, event.result, event.toolCallId);
  });

  pi.on("message_update", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    const snapshot = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const thinking = msg.content
      .filter((b) => b.type === "thinking")
      .map((b) => b.thinking)
      .join("\n");
    void runFeedback.onAssistantDelta(snapshot, thinking);
  });

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
      await runFeedback.onAssistantFinal("", isError);
      return;
    }

    const streamTookOver = await runFeedback.onAssistantFinal(text, isError);
    log.debug("pi", "stream takeover decision", { streamTookOver, isError, textPreview: previewForLog(text) });
    if (streamTookOver) return;

    const payload = markdownToPlain(text);

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

  pi.registerCommand("qq-login", {
    description: "pi-qq: log in with a QR code and bind the scanning QQ user",
    handler: async (_args, ctx) => {
      applyConfig(ctx);
      stopIfRunning();
      setLoginState(undefined);
      let result: QrLoginResult | undefined;
      try {
        result = await runQrLogin(ctx);
      } catch (err) {
        log.error("login", "QR login command failed", { err });
        ctx.ui.notify("Error: QR login failed", "error");
        return;
      }
      if (!result) return;
      if (!result.userOpenid) {
        log.error("login", "QR login did not return a user openid");
        ctx.ui.notify("Error: QR login failed", "error");
        return;
      }

      const credentials: Credentials = { appId: result.appId, appSecret: result.appSecret };
      setLoginState({ credentials, allowedOpenid: result.userOpenid });
      try {
        await startWithCredentials(ctx, credentials, result.userOpenid);
      } catch (err) {
        log.error("login", "starting bot after login failed", { err });
        ctx.ui.notify("Error: QQ bot start failed", "error");
      }
    },
  });

  pi.registerCommand("qq-status", {
    description: "pi-qq: show login, connection, and bound QQ user",
    handler: async (_args, ctx) => {
      ctx.ui.notify(getStatusLines(ctx).join("\n"), "info");
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

  registerQQDiagnostics(pi, {
    getRunning: () => running,
    budget,
    getBoundOpenid: () => getLoginState()?.allowedOpenid,
  });
}
