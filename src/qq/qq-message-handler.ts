import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { sendReply, type ReplyChannel } from "./reply-sender";
import type { ReplyBudget } from "../quota/reply-quota";
import { formatAttachmentFailures, type AttachmentFailure } from "../attachments/attachment-failure";
import {
  formatAttachmentPrompt,
  saveInboundFiles,
  sessionUploadDir,
  type SavedFile,
} from "../attachments/file-attachments";
import { log } from "../infra/file-logger";
import { isVoiceAttachment, resolveVoiceTranscript } from "../attachments/voice-transcript";

export interface InboundDeps {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  budget: ReplyBudget;
  getAllowedOpenid: () => string | undefined;
  getDeliverAs: () => "steer" | "followUp";
  getFileMaxSize: () => number;
  saveFiles?: typeof saveInboundFiles;
  getStatusLines: () => string[];
  onWarn: (msg: string) => void;
  markQQTrigger: (openid: string, msgId: string) => void;
  waitForEnd?: () => Promise<void>;
  onStop?: () => void;
}

export function createInboundHandler(deps: InboundDeps) {
  let pendingAttachments: SavedFile[] = [];
  const takePendingAttachments = (): SavedFile[] => {
    const attachments = pendingAttachments;
    pendingAttachments = [];
    return attachments;
  };

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
    const saveFiles = deps.saveFiles ?? saveInboundFiles;

    const contentText = (msg.content ?? "").trim();
    if (contentText.startsWith("/")) {
      const command = contentText.split(/\s+/)[0];
      log.info("inbound", "QQ command", { command });
      if (command === "/new" && deps.ctx.isIdle() && pendingAttachments.length > 0) {
        log.info("inbound", "cleared pending attachments for /new", { count: pendingAttachments.length });
        pendingAttachments = [];
      }
      await handleCommand(contentText, reply, deps);
      return;
    }

    const attachments = msg.attachments ?? [];
    if (!contentText && attachments.length === 0) {
      log.warn("inbound", "unsupported message: no text and no attachments", { messageId: msg.messageId });
      await reply("Unsupported message type.");
      return;
    }

    let text = contentText;
    const voiceAttachments = attachments.filter(isVoiceAttachment);
    if (voiceAttachments.length > 0) {
      const transcript = resolveVoiceTranscript(voiceAttachments);
      log.info("inbound", "voice message", {
        messageId: msg.messageId,
        hasAsr: Boolean(transcript),
        asrLength: transcript?.length ?? 0,
      });
      if (!transcript) {
        if (!contentText) {
          log.warn("inbound", "voice ASR returned no text", { messageId: msg.messageId });
          await reply("Could not transcribe this voice message; please resend or type it.");
          return;
        }
        log.warn("inbound", "voice ASR returned no text; using text content", { messageId: msg.messageId });
      } else {
        log.debug("inbound", "voice transcript", { messageId: msg.messageId, transcript });
        text = contentText ? `${contentText}\n${transcript}` : transcript;
      }
    }

    // Voice attachments are handled above; all other attachments are stored as files.
    const attachmentsToSave = attachments.filter((attachment) => !isVoiceAttachment(attachment));
    const failures: AttachmentFailure[] = [];

    let files: SavedFile[] = [];
    if (attachmentsToSave.length > 0) {
      const uploadDir = sessionUploadDir(deps.ctx.cwd, deps.ctx.sessionManager.getSessionId());
      log.debug("inbound", "saving attachments", {
        messageId: msg.messageId,
        count: attachmentsToSave.length,
        uploadDir,
      });
      const result = await saveFiles(attachmentsToSave, {
        maxSize: deps.getFileMaxSize(),
        uploadDir,
      });
      files = result.files;
      failures.push(...result.failures);
    }

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
      pendingAttachments.push(...files);
      log.info("inbound", "attachments pending for instruction", {
        messageId: msg.messageId,
        count: files.length,
        pendingCount: pendingAttachments.length,
      });
      return;
    }

    deps.markQQTrigger(msg.senderId, msg.messageId);
    const pending = text ? takePendingAttachments() : [];
    const promptFiles = [...pending, ...files];
    const promptText = formatAttachmentPrompt(promptFiles, text, deps.ctx.cwd);
    deps.pi.sendUserMessage(promptText, { deliverAs: deps.getDeliverAs() });
    log.info("inbound", "sent to pi", {
      messageId: msg.messageId,
      textLength: text.length,
      voice: voiceAttachments.length > 0,
      attachments: promptFiles.length,
      pendingAttachments: pending.length,
      deliverAs: deps.getDeliverAs(),
    });
  };
}

async function handleCommand(text: string, reply: (t: string) => Promise<void>, deps: InboundDeps): Promise<void> {
  const cmd = text.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      await reply(
        [
          "pi-qq commands:",
          "• /stop — abort the current task",
          "• /compact — compact the context",
          "• /status — show status",
          "• /new — reset the session",
          "• /help — this help",
          "Other text is sent to pi.",
        ].join("\n"),
      );
      break;
    case "/stop":
      deps.onStop?.();
      if (deps.ctx.isIdle()) {
        await reply("No task is running.");
      } else {
        deps.ctx.abort();
        await deps.waitForEnd?.();
        await reply("Abort requested.");
      }
      break;
    case "/compact":
      if (deps.ctx.isIdle()) {
        deps.ctx.compact();
        await reply("Context compaction triggered.");
      } else {
        await reply("Task is running; use /stop before /compact.");
      }
      break;
    case "/status":
      await reply(deps.getStatusLines().join("\n"));
      break;
    case "/new":
      if (!deps.ctx.isIdle()) {
        await reply("Task is running; use /stop before resetting.");
      } else {
        await reply("Resetting the session…");
        deps.pi.sendUserMessage("/qq-new", { expandPromptTemplates: true });
      }
      break;
    default:
      await reply(`Unknown command ${cmd}; use /help.`);
  }
}
