import { QQBot, GatewayErrorCode, accessPolicy, concurrencyGuard, contentSanitizer, messageFilter } from "@tencent-connect/qqbot-nodejs";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { Credentials } from "./config";

/**
 * QQBot 实例的会话级生命周期管理：
 * 创建、中间件装配、连接状态跟踪、终态错误上报。
 * start() 阻塞至 stop()/abort，因此在后台运行（void 不等待）。
 */

export type BotState =
  | "stopped" // 未运行 / 已停止
  | "starting" // 已发起连接，等待 READY
  | "connected" // 在线（READY / RESUMED）
  | "reconnecting" // 断线，SDK 自动重连中
  | "blocked"; // 致命关闭（4914 下线 / 4915 封禁），需人工介入

export interface StartBotOptions {
  credentials: Credentials;
  /** F2 单人绑定；未提供时 accessPolicy 放行，由 M2 的"首个私聊用户自动绑定"兜底 */
  allowedOpenid?: string;
  markdownSupport?: boolean;
  /** 诊断模式：SDK 内部日志（超时/限流/重连等）打到终端 */
  debug?: boolean;
  /** 入站消息接线点（M2 起；M1 为空） */
  onMessage?: (bot: QQBot, msg: QQBotInboundMessage) => void | Promise<void>;
  /** 连接状态变化（UI 通知由调用方决定） */
  onStateChange?: (state: BotState, detail?: string) => void;
  /** 可恢复错误（SDK 自动重连，不打扰用户） */
  onRecoverableError?: (err: Error) => void;
}

export interface RunningBot {
  bot: QQBot;
  /** 幂等停止 */
  stop: () => void;
}

export function startBot(opts: StartBotOptions): RunningBot {
  const bot = new QQBot({
    appId: opts.credentials.appId,
    appSecret: opts.credentials.appSecret,
    markdownSupport: opts.markdownSupport ?? false,
  });

  // 回声过滤 + 消息去重（SDK 默认 5s 窗口）
  bot.use(messageFilter({ skipSelfEcho: true }));
  // 清洗 @marker / face tags 等协议标记，只留纯文本
  bot.use(contentSanitizer({ stripBotMention: true }));
  // 单人白名单：仅 C2C 生效；未绑定时放行（自动绑定逻辑在 inbound 层）
  bot.use(
    accessPolicy(
      opts.allowedOpenid
        ? { c2c: { mode: "allowlist", allow: [opts.allowedOpenid] } }
        : {},
    ),
  );
  // 同用户串行处理，避免流式与回复互相踩踏
  bot.use(concurrencyGuard());

  const report = (state: BotState, detail?: string) => opts.onStateChange?.(state, detail);

  bot.on("ready", () => report("connected"));
  bot.on("resumed", () => report("connected"));
  bot.on("disconnected", ({ willReconnect }) => report(willReconnect ? "reconnecting" : "stopped"));
  bot.on("error", (err) => opts.onRecoverableError?.(err));
  bot.on("message", (_ctx, msg) => {
    void opts.onMessage?.(bot, msg);
  });

  let stopped = false;
  report("starting");
  void bot.start().catch((err: unknown) => {
    if (stopped) return; // 主动 stop() 的正常返回，不算错误
    const code = (err as { code?: string }).code;
    if (code === GatewayErrorCode.FATAL_CLOSE) {
      const closeCode = (err as { closeCode?: number }).closeCode;
      report(
        "blocked",
        `连接被服务端致命关闭（${closeCode ?? "未知关闭码"}，4914=已下线/仅沙箱、4915=封禁）：` +
          `请到 QQ 开放平台确认机器人状态，或 /qq-login 重新换绑`,
      );
    } else if (code === GatewayErrorCode.RETRY_EXHAUSTED) {
      report("stopped", `重连预算耗尽：${(err as Error).message}；可执行 /qq-login 重试`);
    } else {
      report("stopped", `启动失败：${(err as Error).message}；请检查凭据与网络`);
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
