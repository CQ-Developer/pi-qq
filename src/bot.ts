import {
  QQBot,
  GatewayErrorCode,
  accessPolicy,
  concurrencyGuard,
  contentSanitizer,
  messageFilter,
} from "@tencent-connect/qqbot-nodejs";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { Credentials } from "./config";
import { log, sdkLogger } from "./logger";

/**
 * Session-level QQBot lifecycle: creation, middleware, connection state,
 * and fatal-error reporting. start() blocks until stop()/abort, so it runs
 * in the background (void, not awaited).
 */

export type BotState =
  | "stopped" // Not running/stopped
  | "starting" // Connecting, waiting for READY
  | "connected" // Online (READY/RESUMED)
  | "reconnecting" // Disconnected; the SDK is reconnecting
  | "blocked"; // Fatal close (4914 offline / 4915 banned); manual action required

export interface StartBotOptions {
  credentials: Credentials;
  /** F2: QR-bound single user; production always provides it */
  allowedOpenid?: string;
  markdownSupport?: boolean;
  /** Inbound message handler. */
  onMessage?: (bot: QQBot, msg: QQBotInboundMessage) => void | Promise<void>;
  /** Connection state changes; the caller decides how to notify the UI. */
  onStateChange?: (state: BotState, detail?: string) => void;
  /** Recoverable errors; the SDK reconnects automatically. */
  onRecoverableError?: (err: Error) => void;
}

export interface RunningBot {
  bot: QQBot;
  /** Idempotent stop. */
  stop: () => void;
}

export function startBot(opts: StartBotOptions): RunningBot {
  log.info("bot", "starting", {
    appId: opts.credentials.appId,
    allowedOpenid: opts.allowedOpenid,
    markdownSupport: opts.markdownSupport,
  });

  const bot = new QQBot({
    appId: opts.credentials.appId,
    appSecret: opts.credentials.appSecret,
    markdownSupport: opts.markdownSupport ?? false,
    logger: sdkLogger,
  });

  // Echo filtering + message deduplication (SDK default 5s window).
  bot.use(messageFilter({ skipSelfEcho: true }));
  // Strip protocol markers such as @mentions and face tags.
  bot.use(contentSanitizer({ stripBotMention: true }));
  // Single-user allowlist for C2C; inbound also rejects when no QR login is active.
  bot.use(accessPolicy(opts.allowedOpenid ? { c2c: { mode: "allowlist", allow: [opts.allowedOpenid] } } : {}));
  // Serialize per user so streams and replies do not race.
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
    opts.onRecoverableError?.(err);
  });
  bot.on("message", (_ctx, msg) => {
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
    Promise.resolve(opts.onMessage?.(bot, msg)).catch((err: unknown) => {
      log.error("bot", "message handler rejected", { err });
    });
  });

  let stopped = false;
  report("starting");
  void bot.start().catch((err: unknown) => {
    if (stopped) return; // Normal return from an explicit stop().
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
