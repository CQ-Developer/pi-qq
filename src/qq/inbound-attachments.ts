import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { AttachmentFailure } from "../attachments/attachment-failure";
import { saveInboundFiles, type SavedFile } from "../attachments/file-attachments";
import { log } from "../infra/file-logger";
import { t } from "../infra/i18n";
import { isVoiceAttachment, resolveVoiceTranscript } from "../attachments/voice-transcript";

export interface ResolveInboundOptions {
  contentText: string;
  maxSize: number;
  uploadDir: string;
  saveFiles: typeof saveInboundFiles;
}

export type ResolvedInbound =
  | { status: "rejected"; reply: string }
  | {
      status: "resolved";
      text: string;
      files: SavedFile[];
      failures: AttachmentFailure[];
      voiceCount: number;
    };

/**
 * Turn one inbound message into injectable content: prefer ASR for voice,
 * persist every non-voice attachment, and report per-file failures.
 */
export async function resolveInboundContent(
  msg: QQBotInboundMessage,
  options: ResolveInboundOptions,
): Promise<ResolvedInbound> {
  const attachments = msg.attachments ?? [];
  let text = options.contentText;

  const voiceAttachments = attachments.filter(isVoiceAttachment);
  if (voiceAttachments.length > 0) {
    const transcript = resolveVoiceTranscript(voiceAttachments);
    log.info("inbound", "voice message", {
      messageId: msg.messageId,
      hasAsr: Boolean(transcript),
      asrLength: transcript?.length ?? 0,
    });
    if (!transcript) {
      if (!options.contentText) {
        log.warn("inbound", "voice ASR returned no text", { messageId: msg.messageId });
        return {
          status: "rejected",
          reply: t("inbound.voiceFailed"),
        };
      }
      log.warn("inbound", "voice ASR returned no text; using text content", { messageId: msg.messageId });
    } else {
      log.debug("inbound", "voice transcript", { messageId: msg.messageId, transcript });
      text = options.contentText ? `${options.contentText}\n${transcript}` : transcript;
    }
  }

  // Voice attachments are handled above; all other attachments are stored as files.
  const attachmentsToSave = attachments.filter((attachment) => !isVoiceAttachment(attachment));
  const failures: AttachmentFailure[] = [];
  let files: SavedFile[] = [];

  if (attachmentsToSave.length > 0) {
    log.debug("inbound", "saving attachments", {
      messageId: msg.messageId,
      count: attachmentsToSave.length,
      uploadDir: options.uploadDir,
    });
    const result = await options.saveFiles(attachmentsToSave, {
      maxSize: options.maxSize,
      uploadDir: options.uploadDir,
    });
    files = result.files;
    failures.push(...result.failures);
  }

  return { status: "resolved", text, files, failures, voiceCount: voiceAttachments.length };
}

/** Attachments that arrived without an instruction, consumed by the next text or voice message. */
export class PendingAttachments {
  private files: SavedFile[] = [];

  get count(): number {
    return this.files.length;
  }

  add(files: SavedFile[]): void {
    if (files.length > 0) this.files.push(...files);
  }

  take(): SavedFile[] {
    const files = this.files;
    this.files = [];
    return files;
  }

  clear(): void {
    this.files = [];
  }
}
