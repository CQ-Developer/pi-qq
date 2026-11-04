import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getSettings, readConfig, type Credentials, type ResolvedSettings } from "./src/infra/settings";
import { startBot, type BotState, type RunningBot } from "./src/qq/qq-bot";
import { runQrLogin, type QrLoginResult } from "./src/qq/qr-login";
import { createInboundHandler } from "./src/qq/qq-message-handler";
import { registerQQDiagnostics } from "./src/qq/qq-diagnostics";
import { markdownToPlain, sendReply } from "./src/qq/reply-sender";
import { ReplyBudget } from "./src/quota/reply-quota";
import { RunFeedback } from "./src/relay/run-stream-relay";
import { configureLogger, flushLogs, isLogEnabled, log, previewForLog } from "./src/infra/file-logger";
import { configureI18n, t } from "./src/infra/i18n";
import { getPowerStatus } from "./src/infra/power-status";
import { formatStatusReport } from "./src/qq/status-report";
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

const eventLoopDelay = monitorEventLoopDelay({ resolution: 100 });
let eventLoopTimer: ReturnType<typeof setInterval> | undefined;

interface ToolUpdateStats {
  count: number;
  firstAt: number;
  lastAt: number;
  firstPartial: string;
}

const toolUpdateStats = new Map<string, ToolUpdateStats>();
const TOOL_UPDATE_LOG_EVERY = 50;

function clearToolUpdateStats(): void {
  toolUpdateStats.clear();
}

function roundMs(value: number): number {
  return Math.round((value / 1e6) * 10) / 10;
}

function startEventLoopMonitor(): void {
  if (!isLogEnabled("debug") || eventLoopTimer) return;
  eventLoopDelay.disable();
  eventLoopDelay.reset();
  eventLoopDelay.enable();
  let lastTickAt = Date.now();
  eventLoopTimer = setInterval(() => {
    const now = Date.now();
    const driftMs = now - lastTickAt - 5_000;
    lastTickAt = now;
    log.debug("event-loop", "event loop delay", {
      meanMs: roundMs(eventLoopDelay.mean),
      maxMs: roundMs(eventLoopDelay.max),
      p99Ms: roundMs(eventLoopDelay.percentile(99)),
      driftMs,
    });
    eventLoopDelay.reset();
  }, 5_000);
  eventLoopTimer.unref?.();
}

function stopEventLoopMonitor(): void {
  if (eventLoopTimer) clearInterval(eventLoopTimer);
  eventLoopTimer = undefined;
  eventLoopDelay.disable();
}

export default function (pi: ExtensionAPI) {
  activeSettings = getSettings(readConfig().config);
  configureI18n(activeSettings.language);

  const getAllowedOpenid = () => getLoginState()?.allowedOpenid;
  const getDeliverAs = () => activeSettings.deliverAs;

  const onWarn = (ctx: ExtensionContext) => (msg: string) => ctx.ui.notify(`pi-qq ${msg}`, "warning");

  const applyConfig = (ctx: ExtensionContext) => {
    const { config, error } = readConfig();
    activeSettings = getSettings(config);
    configureI18n(activeSettings.language);
    if (error) ctx.ui.notify(`pi-qq ${error}`, "error");
    return { settings: activeSettings, error };
  };

  const getStatusLines = (ctx: ExtensionContext | undefined = sessionCtx): string[] => {
    const login = getLoginState();
    const usage = ctx?.getContextUsage();
    return formatStatusReport({
      login: login ? { appId: login.credentials.appId, openid: login.allowedOpenid } : undefined,
      connection: { state: lastState, detail: stateDetail },
      agent: {
        running: ctx ? !ctx.isIdle() : runFeedback.isQQRunActive(),
        qq: runFeedback.isQQRunActive(),
      },
      model: ctx?.model ? { name: ctx.model.name } : undefined,
      usage: usage
        ? {
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
          }
        : undefined,
      power: getPowerStatus(),
    });
  };

  const stopIfRunning = () => {
    running?.stop();
    running = undefined;
    lastState = "stopped";
    stateDetail = undefined;
    sessionCtx = undefined;
    runFeedback.dispose();
    clearToolUpdateStats();
    stopEventLoopMonitor();
  };

  const startWithCredentials = async (ctx: ExtensionContext, creds: Credentials, allowedOpenid: string) => {
    const settings = activeSettings;
    configureLogger(settings.logLevel, join(ctx.cwd, ".pi", "pi-qq", "logs"));
    stopIfRunning();
    startEventLoopMonitor();
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
        getLastMessage: () => runFeedback.getLastMessage(),
        repushCurrent: (openid, msgId) => runFeedback.repushCurrent(openid, msgId),
        onWarn: onWarn(ctx),
        markQQTrigger: (openid, msgId) => runFeedback.markQQTrigger(openid, msgId),
        waitForEnd: () => runFeedback.waitForEnd(),
        onStop: () => runFeedback.cancelRecovery(),
      }),
      onStateChange: (state, detail) => {
        lastState = state;
        stateDetail = detail;
        if (state === "connected") ctx.ui.notify(t("notify.connected"), "info");
        else if (state === "blocked") ctx.ui.notify(`pi-qq ${detail ?? t("notify.connectionBlocked")}`, "error");
        else if (state === "stopped" && detail) ctx.ui.notify(`pi-qq ${detail}`, "warning");
      },
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const { settings, error } = applyConfig(ctx);
    configureLogger(settings.logLevel, join(ctx.cwd, ".pi", "pi-qq", "logs"));
    startEventLoopMonitor();

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
      ctx.ui.notify(t("notify.loginRequired"), "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    log.info("session", "shutting down");
    stopIfRunning();
    await flushLogs();
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
    toolUpdateStats.delete(event.toolCallId);
    if (isLogEnabled("debug")) {
      log.debug("tool", "start", {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId ?? null,
        at: Date.now(),
        args: previewForLog(event.args),
      });
    }
    void runFeedback.onToolStart(event.toolName, event.args, event.toolCallId);
  });

  pi.on("tool_execution_update", (event) => {
    if (!isLogEnabled("debug")) return;
    const now = Date.now();
    const existing = toolUpdateStats.get(event.toolCallId);
    if (!existing) {
      const first: ToolUpdateStats = {
        count: 1,
        firstAt: now,
        lastAt: now,
        firstPartial: previewForLog(event.partialResult, 300),
      };
      toolUpdateStats.set(event.toolCallId, first);
      log.debug("tool", "update", {
        phase: "first",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        count: 1,
        partial: first.firstPartial,
      });
      return;
    }
    existing.count += 1;
    existing.lastAt = now;
    if (existing.count % TOOL_UPDATE_LOG_EVERY === 0) {
      log.debug("tool", "update", {
        phase: "progress",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        count: existing.count,
        spanMs: existing.lastAt - existing.firstAt,
      });
    }
  });

  pi.on("tool_execution_end", (event) => {
    const updates = toolUpdateStats.get(event.toolCallId);
    toolUpdateStats.delete(event.toolCallId);
    if (isLogEnabled("debug")) {
      log.debug("tool", "end", {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        parentToolCallId: event.parentToolCallId ?? null,
        isError: event.isError,
        durationMs: event.durationMs ?? null,
        updateCount: updates?.count ?? 0,
        updateSpanMs: updates ? updates.lastAt - updates.firstAt : null,
        firstPartial: updates?.firstPartial ?? null,
        result: previewForLog(event.result),
      });
    }
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
    if (isLogEnabled("debug")) {
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
    }
    if (!fromQQ) return;

    const isError = msg.stopReason === "error";

    let text: string;
    if (isError) {
      text = t("errors.model", { message: msg.errorMessage ?? t("status.unknown") });
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
    if (isLogEnabled("debug")) {
      log.debug("pi", "stream takeover decision", { streamTookOver, isError, textPreview: previewForLog(text) });
    }
    if (streamTookOver) return;

    const payload = markdownToPlain(text);

    const bound = getLoginState()?.allowedOpenid;
    if (!bound) {
      log.warn("pi", "no bound user; reply skipped");
      ctx.ui.notify(t("notify.noBoundUser"), "warning");
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
    description: t("commands.descQqLogin"),
    handler: async (_args, ctx) => {
      applyConfig(ctx);
      stopIfRunning();
      setLoginState(undefined);
      let result: QrLoginResult | undefined;
      try {
        result = await runQrLogin(ctx);
      } catch (err) {
        log.error("login", "QR login command failed", { err });
        ctx.ui.notify(t("login.failed"), "error");
        return;
      }
      if (!result) return;
      if (!result.userOpenid) {
        log.error("login", "QR login did not return a user openid");
        ctx.ui.notify(t("login.failed"), "error");
        return;
      }

      const credentials: Credentials = { appId: result.appId, appSecret: result.appSecret };
      setLoginState({ credentials, allowedOpenid: result.userOpenid });
      try {
        await startWithCredentials(ctx, credentials, result.userOpenid);
      } catch (err) {
        log.error("login", "starting bot after login failed", { err });
        ctx.ui.notify(t("login.startFailed"), "error");
      }
    },
  });

  pi.registerCommand("qq-status", {
    description: t("commands.descQqStatus"),
    handler: async (_args, ctx) => {
      ctx.ui.notify(getStatusLines(ctx).join("\n"), "info");
    },
  });

  pi.registerCommand("qq-logout", {
    description: t("commands.descQqLogout"),
    handler: async (_args, ctx) => {
      stopIfRunning();
      setLoginState(undefined);
      ctx.ui.notify(t("notify.loggedOut"), "info");
    },
  });

  pi.registerCommand("qq-new", {
    description: t("commands.descQqNew"),
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify(t("notify.busyReset"), "warning");
        return;
      }
      const { cancelled } = await ctx.newSession();
      if (cancelled) ctx.ui.notify(t("notify.resetCancelled"), "warning");
    },
  });

  registerQQDiagnostics(pi, {
    getRunning: () => running,
    budget,
    getBoundOpenid: () => getLoginState()?.allowedOpenid,
  });
}
