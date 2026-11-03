import {
  QQBot,
  GatewayErrorCode,
  accessPolicy,
  concurrencyGuard,
  contentSanitizer,
  messageFilter,
} from "@tencent-connect/qqbot-nodejs";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { Credentials } from "./settings";
import { log, sdkLogger } from "./file-logger";

export type BotState = "stopped" | "starting" | "connected" | "reconnecting" | "blocked";

export interface StartBotOptions {
  credentials: Credentials;
  allowedOpenid?: string;
  onMessage?: (bot: QQBot, msg: QQBotInboundMessage) => void | Promise<void>;
  onStateChange?: (state: BotState, detail?: string) => void;
}

export interface RunningBot {
  bot: QQBot;
  stop: () => void;
}

export function startBot(opts: StartBotOptions): RunningBot {
  log.info("bot", "starting", {
    appId: opts.credentials.appId,
    allowedOpenid: opts.allowedOpenid,
  });

  const bot = new QQBot({
    appId: opts.credentials.appId,
    appSecret: opts.credentials.appSecret,
    logger: sdkLogger,
  });

  bot.use(messageFilter({ skipSelfEcho: true }));
  bot.use(contentSanitizer({ stripBotMention: true }));
  bot.use(accessPolicy(opts.allowedOpenid ? { c2c: { mode: "allowlist", allow: [opts.allowedOpenid] } } : {}));
  bot.use(concurrencyGuard());

  const report = (state: BotState, detail?: string) => {
    if (state === "blocked" || (state === "stopped" && detail)) {
      log.error("bot", state, { detail });
    } else if (state === "reconnecting") {
      log.warn("bot", state, { detail });
    } else {
      log.info("bot", state, { detail });
    }
    opts.onStateChange?.(state, detail);
  };

  bot.on("ready", () => report("connected"));
  bot.on("resumed", () => report("connected"));
  bot.on("disconnected", ({ willReconnect }) => report(willReconnect ? "reconnecting" : "stopped"));
  bot.on("error", (err) => {
    log.error("bot", "error event", { err });
  });
  bot.on("message", async (_ctx, msg) => {
    log.debug("bot", "inbound message", {
      kind: msg.kind,
      rawEventType: msg.rawEventType,
      messageId: msg.messageId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      senderIsBot: msg.senderIsBot,
      content: msg.content,
      msgType: msg.msgType,
      timestamp: msg.timestamp,
      replyTarget: msg.replyTarget,
      msgIdx: msg.msgIdx,
      refMsgIdx: msg.refMsgIdx,
      messageScene: msg.messageScene,
      attachments: msg.attachments,
      msgElements: msg.msgElements,
      raw: msg.raw,
    });
    try {
      await opts.onMessage?.(bot, msg);
    } catch (err) {
      log.error("bot", "message handler rejected", { err });
    }
  });

  let stopped = false;
  report("starting");
  void bot.start().catch((err: unknown) => {
    if (stopped) return;
    const code = (err as { code?: string }).code;
    if (code === GatewayErrorCode.FATAL_CLOSE) {
      const closeCode = (err as { closeCode?: number }).closeCode;
      report(
        "blocked",
        `Connection closed by the server (${closeCode ?? "unknown"}, 4914=offline/sandbox, 4915=banned). ` +
          `Check the bot status on the QQ Open Platform, or run /qq-login again.`,
      );
    } else if (code === GatewayErrorCode.RETRY_EXHAUSTED) {
      report("stopped", `Reconnect budget exhausted: ${(err as Error).message}; run /qq-login to retry.`);
    } else {
      report("stopped", `Startup failed: ${(err as Error).message}; check credentials and network.`);
    }
  });

  return {
    bot,
    stop() {
      if (stopped) return;
      stopped = true;
      bot.stop();
    },
  };
}
