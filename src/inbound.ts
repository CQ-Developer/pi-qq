import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
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
 * F2: QQ → pi inbound handling.
 * Chain: C2C filter → QR-bound user whitelist → QQ commands → text/image/file injection.
 * Use pi.sendUserMessage (ExtensionContext has no such API).
 */

export interface InboundDeps {
  pi: ExtensionAPI;
  /** Session context captured at session_start: ui/isIdle/abort/compact/getContextUsage. */
  ctx: ExtensionContext;
  budget: ReplyBudget;
  /** Read settings live so changes apply immediately. */
  getAllowedOpenid: () => string | undefined;
  getBoundOpenid: () => string | undefined;
  getDeliverAs: () => "steer" | "followUp";
  getImageMaxSize: () => number;
  getFileMaxSize: () => number;
  /** Test override; defaults to saveInboundFiles. */
  saveFiles?: typeof saveInboundFiles;
  getStatusLines: () => string[];
  onWarn: (msg: string) => void;
  /** F7: mark the next run as QQ-triggered (for typing/heartbeat/timeline). */
  markQQTrigger: (openid: string, msgId: string) => void;
}

export function createInboundHandler(deps: InboundDeps) {
  return async (bot: QQBot, msg: QQBotInboundMessage): Promise<void> => {
    if (msg.kind !== "c2c") return;

    const allowed = deps.getAllowedOpenid();
    if (!allowed || msg.senderId !== allowed) return;

    // Record passive reply target/freshness for outbound budget.
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

    // F3: images become ImageContent; other attachments are saved and referenced by path.
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

    // F7: mark a QQ-triggered run; do not send a start confirmation.
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
        // Built-in /new is interactive-only; dispatch the extension command instead.
        deps.pi.sendUserMessage("/qq-new", { expandPromptTemplates: true });
      }
      break;
    default:
      await reply(`未知命令 ${cmd}，发送 /help 查看支持命令`);
  }
}
