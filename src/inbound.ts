import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { setAllowedOpenid } from "./config";
import { sendReply, type ReplyChannel } from "./outbound";
import type { ReplyBudget } from "./reply-budget";
import {
  buildImageMessageContent,
  formatImageFailures,
  isImageAttachment,
  resolveInboundImages,
  type ImageContentLike,
} from "./images";
import { formatFilePrompt, saveInboundFiles, type SavedFile } from "./files";

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
  getImageMaxSize: () => number;
  getFileMaxSize: () => number;
  /** 测试可注入；默认 saveInboundFiles */
  saveFiles?: typeof saveInboundFiles;
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
    const saveFiles = deps.saveFiles ?? saveInboundFiles;

    const text = (msg.content ?? "").trim();
    if (text.startsWith("/")) {
      await handleCommand(text, reply, deps);
      return;
    }

    const attachments = msg.attachments ?? [];
    if (!text && attachments.length === 0) {
      await reply("暂不支持该消息类型");
      return;
    }

    // F3：图片转 ImageContent，非图片附件保存到本地并在提示词中给出路径
    const imageAttachments = attachments.filter(isImageAttachment);
    const fileAttachments = attachments.filter((attachment) => !isImageAttachment(attachment));
    const failures: Array<{ filename: string; reason: string }> = [];

    let images: ImageContentLike[] = [];
    if (imageAttachments.length > 0) {
      const supportsImages = deps.ctx.model?.input.includes("image") ?? false;
      if (!supportsImages) {
        await reply(`当前模型不支持图片输入，已跳过 ${imageAttachments.length} 张图片`);
      } else {
        const result = await resolveInboundImages(imageAttachments, deps.getImageMaxSize());
        images = result.images;
        failures.push(...result.failures);
      }
    }

    let files: SavedFile[] = [];
    if (fileAttachments.length > 0) {
      const result = await saveFiles(fileAttachments, {
        maxSize: deps.getFileMaxSize(),
        baseDir: join(deps.ctx.cwd, ".pi", "pi-qq"),
        dirKey: msg.messageId,
      });
      files = result.files;
      failures.push(...result.failures);
    }

    if (failures.length > 0) {
      await reply(formatImageFailures(failures, images.length + files.length));
    }
    if (!text && images.length === 0 && files.length === 0) return;

    // F7：标记 QQ 触发的 run（RunFeedback 据此建立 typing/时间线），不发送开始确认
    deps.markQQTrigger(msg.senderId, msg.messageId);
    const promptText = formatFilePrompt(files, text);
    deps.pi.sendUserMessage(buildImageMessageContent(promptText, images), { deliverAs: deps.getDeliverAs() });
  };
}

async function handleCommand(text: string, reply: (t: string) => Promise<void>, deps: InboundDeps): Promise<void> {
  const cmd = text.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      await reply(
        [
          "pi-qq 命令：",
          "• /stop — 中止当前任务",
          "• /compact — 压缩上下文",
          "• /status — 查看状态",
          "• /new — 重置会话",
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
      if (!deps.ctx.isIdle()) {
        await reply("任务运行中，请先 /stop 再重置会话");
      } else {
        await reply("正在重置会话…");
        // 内置 /new 仅在交互模式处理；这里通过扩展命令调用 ctx.newSession
        deps.pi.sendUserMessage("/qq-new", { expandPromptTemplates: true });
      }
      break;
    default:
      await reply(`未知命令 ${cmd}，发送 /help 查看支持命令`);
  }
}
