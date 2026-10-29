import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { setAllowedOpenid } from "./config";
import { sendReply, type ReplyChannel } from "./outbound";
import type { ReplyBudget } from "./reply-budget";

/**
 * F2：QQ → pi 入站处理。
 * 链路：C2C 过滤 → 单人白名单（含首个用户自动绑定）→ QQ 侧命令拦截 → 文本注入 pi。
 * 注意：注入消息必须用 pi.sendUserMessage（ExtensionContext 上没有该 API）。
 */

export interface InboundDeps {
  pi: ExtensionAPI;
  /** session_start 时捕获的会话上下文：ui/isIdle/abort/compact/getContextUsage */
  ctx: ExtensionContext;
  budget: ReplyBudget;
  /** 均实时读配置，绑定关系变更即时生效 */
  getAllowedOpenid: () => string | undefined;
  getBoundOpenid: () => string | undefined;
  getDeliverAs: () => "steer" | "followUp";
  getStatusLines: () => string[];
  onWarn: (msg: string) => void;
  /** F7：标记接下来的 run 由 QQ 触发（供 RunFeedback 建立确认/心跳/typing） */
  markQQTrigger: (openid: string, msgId: string) => void;
}

export function createInboundHandler(deps: InboundDeps) {
  return async (bot: QQBot, msg: QQBotInboundMessage): Promise<void> => {
    if (msg.kind !== "c2c") return;

    const allowed = deps.getAllowedOpenid();
    if (allowed && msg.senderId !== allowed) return;

    // 未绑定 → 首个私聊用户自动绑定（features.md F1 方式 A 说明）
    if (!allowed) {
      setAllowedOpenid(msg.senderId);
      deps.ctx.ui.notify(`pi-qq：已自动绑定首个私聊用户（${msg.senderId.slice(0, 8)}…）`, "info");
    }

    // 记录被动回复目标与新鲜度起点（供 outbound 发牌）
    deps.budget.observeInbound(msg.senderId, msg.messageId);

    const channel: ReplyChannel = {
      budget: deps.budget,
      boundOpenid: deps.getBoundOpenid() ?? msg.senderId,
      onWarn: deps.onWarn,
    };
    const reply = (text: string) => sendReply(bot, text, channel);

    const text = (msg.content ?? "").trim();
    if (text.startsWith("/")) {
      await handleCommand(text, reply, deps);
      return;
    }
    if (!text) {
      // F3 图片消息在 M4 接入
      await reply("图片消息将在后续版本支持，当前请配合文字发送");
      return;
    }

    // F7：标记 QQ 触发的 run（RunFeedback 据此建立 typing/时间线），不发送开始确认
    deps.markQQTrigger(msg.senderId, msg.messageId);
    deps.pi.sendUserMessage(text, { deliverAs: deps.getDeliverAs() });
  };
}

async function handleCommand(
  text: string,
  reply: (t: string) => Promise<void>,
  deps: InboundDeps,
): Promise<void> {
  const cmd = text.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      await reply(
        [
          "pi-qq 命令：",
          "• /stop — 中止当前任务",
          "• /compact — 压缩上下文",
          "• /status — 查看状态",
          "• /new — 重置会话（需在 pi 终端执行）",
          "• /help — 本帮助",
          "其他文字将直接发送给 pi",
        ].join("\n"),
      );
      break;
    case "/stop":
      if (deps.ctx.isIdle()) {
        await reply("当前没有正在运行的任务");
      } else {
        deps.ctx.abort();
        await reply("已请求中止当前任务");
      }
      break;
    case "/compact":
      if (deps.ctx.isIdle()) {
        deps.ctx.compact();
        await reply("已触发上下文压缩");
      } else {
        await reply("任务运行中，请先 /stop 再压缩");
      }
      break;
    case "/status":
      await reply(deps.getStatusLines().join("\n"));
      break;
    case "/new":
      await reply("QQ 侧暂不支持重置会话，请在 pi 终端执行 /new");
      break;
    default:
      await reply(`未知命令 ${cmd}，发送 /help 查看支持命令`);
  }
}
