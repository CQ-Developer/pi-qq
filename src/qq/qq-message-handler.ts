import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { sendReply, type ReplyChannel } from "./reply-sender";
import type { ReplyBudget } from "../quota/reply-quota";
import { formatAttachmentFailures } from "../attachments/attachment-failure";
import {
  formatAttachmentPrompt,
  saveInboundFiles,
  sessionUploadDir,
  type SavedFile,
} from "../attachments/file-attachments";
import { log } from "../infra/file-logger";
import { handleInboundCommand, type InboundCommandDeps } from "./inbound-command";
import { PendingAttachments, resolveInboundContent } from "./inbound-attachments";

export interface InboundDeps extends InboundCommandDeps {
  budget: ReplyBudget;
  getAllowedOpenid: () => string | undefined;
  getDeliverAs: () => "steer" | "followUp";
  getFileMaxSize: () => number;
  saveFiles?: typeof saveInboundFiles;
  onWarn: (msg: string) => void;
  markQQTrigger: (openid: string, msgId: string) => void;
}

export function createInboundHandler(deps: InboundDeps) {
  const pending = new PendingAttachments();

  return async (bot: QQBot, msg: QQBotInboundMessage): Promise<void> => {
    log.debug("inbound", "message received", {
      kind: msg.kind,
      rawEventType: msg.rawEventType,
      messageId: msg.messageId,
      senderId: msg.senderId,
      senderName: msg.senderName,
      senderIsBot: msg.senderIsBot,
      content: msg.content,
      msgType: msg.msgType,
      timestamp: msg.timestamp,
      msgIdx: msg.msgIdx,
      refMsgIdx: msg.refMsgIdx,
      messageScene: msg.messageScene,
      attachments: msg.attachments,
      msgElements: msg.msgElements,
      raw: msg.raw,
    });

    if (msg.kind !== "c2c") {
      log.debug("inbound", "skipped non-c2c message", { kind: msg.kind });
      return;
    }

    const allowed = deps.getAllowedOpenid();
    if (!allowed || msg.senderId !== allowed) {
      log.debug("inbound", "skipped non-allowlisted sender", { senderId: msg.senderId });
      return;
    }

    deps.budget.observeInbound(msg.senderId, msg.messageId);
    log.info("inbound", "message received", {
      messageId: msg.messageId,
      senderId: msg.senderId,
      contentLength: (msg.content ?? "").length,
      attachmentCount: (msg.attachments ?? []).length,
    });

    const channel: ReplyChannel = {
      budget: deps.budget,
      boundOpenid: deps.getAllowedOpenid() ?? msg.senderId,
      onWarn: deps.onWarn,
    };
    const reply = (text: string) => sendReply(bot, text, channel);

    const contentText = (msg.content ?? "").trim();
    if (contentText.startsWith("/")) {
      const command = contentText.split(/\s+/)[0];
      log.info("inbound", "QQ command", { command });
      if (command === "/new" && deps.ctx.isIdle() && pending.count > 0) {
        log.info("inbound", "cleared pending attachments for /new", { count: pending.count });
        pending.clear();
      }
      await handleInboundCommand(contentText, reply, deps);
      return;
    }

    const attachments = msg.attachments ?? [];
    if (!contentText && attachments.length === 0) {
      log.warn("inbound", "unsupported message: no text and no attachments", { messageId: msg.messageId });
      await reply("Unsupported message type.");
      return;
    }

    const resolved = await resolveInboundContent(msg, {
      contentText,
      maxSize: deps.getFileMaxSize(),
      uploadDir: sessionUploadDir(deps.ctx.cwd, deps.ctx.sessionManager.getSessionId()),
      saveFiles: deps.saveFiles ?? saveInboundFiles,
    });
    if (resolved.status === "rejected") {
      await reply(resolved.reply);
      return;
    }
    const { text, files, failures, voiceCount } = resolved;

    if (failures.length > 0) {
      log.warn("inbound", "attachment failure summary", {
        messageId: msg.messageId,
        failures,
        successCount: files.length,
      });
      await reply(formatAttachmentFailures(failures, files.length));
    }
    if (!text && files.length === 0) {
      log.warn("inbound", "no injectable content after attachment handling", {
        messageId: msg.messageId,
        failures: failures.length,
      });
      return;
    }

    if (!text && files.length > 0) {
      pending.add(files);
      log.info("inbound", "attachments pending for instruction", {
        messageId: msg.messageId,
        count: files.length,
        pendingCount: pending.count,
      });
      return;
    }

    deps.markQQTrigger(msg.senderId, msg.messageId);
    const pendingFiles = text ? pending.take() : [];
    const promptFiles: SavedFile[] = [...pendingFiles, ...files];
    const promptText = formatAttachmentPrompt(promptFiles, text, deps.ctx.cwd);
    deps.pi.sendUserMessage(promptText, { deliverAs: deps.getDeliverAs() });
    log.info("inbound", "sent to pi", {
      messageId: msg.messageId,
      textLength: text.length,
      voice: voiceCount > 0,
      attachments: promptFiles.length,
      pendingAttachments: pendingFiles.length,
      deliverAs: deps.getDeliverAs(),
    });
  };
}
