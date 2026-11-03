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
const budget = new ReplyBudget();
const runFeedback = new RunFeedback({
  bot: () => running?.bot,
  budget,
  getThinkingRelay: () => getSettings(readConfig().config).thinkingRelay,
  onWarn: (msg) => sessionCtx?.ui.notify(`pi-qq ${msg}`, "warning"),
});

const fmtTokens = (n: number | null): string => (n === null ? "unknown" : formatTokenCount(n));

export default function (pi: ExtensionAPI) {
  const maskAppId = (appId: string) => `${appId.slice(0, 4)}****`;

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
        getBoundOpenid,
        getDeliverAs,
        getImageMaxSize: () => getSettings(readConfig().config).imageMaxSize,
        getFileMaxSize: () => getSettings(readConfig().config).fileMaxSize,
        getStatusLines,
        onWarn: onWarn(ctx),
        markQQTrigger: (openid, msgId) => runFeedback.markQQTrigger(openid, msgId),
        waitForEnd: () => runFeedback.waitForEnd(),
      }),
      onStateChange: (state, detail) => {
        lastState = state;
        stateDetail = detail;
        if (state === "connected") ctx.ui.notify("pi-qq connected", "info");
        else if (state === "blocked") ctx.ui.notify(`pi-qq ${detail ?? "connection blocked"}`, "error");
        else if (state === "stopped" && detail) ctx.ui.notify(`pi-qq ${detail}`, "warning");
      },
      onRecoverableError: () => {},
    });
  };

  const stopIfRunning = () => {
    running?.stop();
    running = undefined;
    lastState = "stopped";
    stateDetail = undefined;
  };

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
      const { error } = readConfig();
      if (error) ctx.ui.notify(`pi-qq ${error}`, "error");

      stopIfRunning();
      setLoginState(undefined);
      let result;
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
    description: "pi-qq: run a streamed timeline diagnostic (thinking/tools/text) or resume probe",
    handler: async (args, ctx) => {
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
        if (args?.trim() === "short") {
          const variants = [
            { label: "plain 11", content: "plain short" },
            { label: "quote 13", content: "> quote short" },
            { label: "quote 17 + blank", content: "> quote short\n>\n" },
            { label: "quote 34 two lines", content: "> quote line one\n> quote line two\n" },
            { label: "quote 48", content: "> We need build project. Need inspect cwd. Must\n" },
            { label: "quote 50 + blank", content: "> We need build project. Need inspect cwd. Must\n>\n" },
            { label: "plain 48", content: "We need build project. Need inspect cwd. Must\n" },
            { label: "plain 22 zh", content: "项目骨架已就绪。接下来实现后端 API。" },
            { label: "tool 44", content: "**bash**\n\n`echo short`\n\n```text\nshort\n```\n" },
          ];
          const notes: string[] = [];
          for (const [index, variant] of variants.entries()) {
            const stream = new AppendStream(
              running.bot.messageApi,
              running.bot.getCredentials(),
              last.openid,
              last.msgId,
            );
            try {
              await stream.append(variant.content);
              await stream.done();
              notes.push(`${index + 1}:${variant.label}:ok`);
            } catch (err) {
              notes.push(`${index + 1}:${variant.label}:${(err as Error).message}`);
            } finally {
              stream.dispose();
            }
            await sleep(900);
          }
          ctx.ui.notify(
            `Short stream variants sent in order: ${notes.join(" | ")}. Check which bubbles render and which show unsupported.`,
            "info",
          );
          return;
        }
        if (args?.trim() === "resume") {
          const first = new AppendStream(running.bot.messageApi, running.bot.getCredentials(), last.openid, last.msgId);
          await first.append("**Resume probe** frame 1\n");
          await first.flush();
          const checkpoint = first.checkpoint();
          first.dispose();
          if (!checkpoint?.streamMsgId) {
            ctx.ui.notify("Resume probe: frame 1 sent but stream_msg_id is missing; cannot resume.", "error");
            return;
          }
          await sleep(800);
          const second = new AppendStream(
            running.bot.messageApi,
            running.bot.getCredentials(),
            last.openid,
            last.msgId,
            {
              resume: checkpoint,
            },
          );
          await second.append("frame 2 after resume\n");
          await second.done();
          ctx.ui.notify(
            `Resume probe: frame 2 sent with index ${checkpoint.index} and stream_msg_id ${checkpoint.streamMsgId}. Check whether both frames are in the same bubble.`,
            "info",
          );
          return;
        }
        const stream = new AppendStream(running.bot.messageApi, running.bot.getCredentials(), last.openid, last.msgId);
        await stream.append("> probe thinking\n> second line\n\n**bash**\n\n`echo probe`\n\n```text\nprobe\n```\n");
        await sleep(1200);
        await stream.append("\n**Intermediate message**: first-turn reply.\n");
        await sleep(1200);
        await stream.append("\n**read**\n\n`src/index.ts`\n\n```text\nprobe file\n```\n");
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
