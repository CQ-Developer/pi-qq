import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { AttachmentFailure } from "../attachments/attachment-failure";
import { saveInboundFiles, type SavedFile } from "../attachments/file-attachments";
import { log } from "../infra/file-logger";
import { t } from "../infra/i18n";
import { isVoiceAttachment, resolveVoiceTranscript } from "../attachments/voice-transcript";

interface ResolveInboundOptions {
  contentText: string;
  maxSize: number;
  uploadDir: string;
  saveFiles: typeof saveInboundFiles;
}

type ResolvedInbound =
  | { status: "rejected"; reply: string }
  | {
      status: "resolved";
      text: string;
      files: SavedFile[];
      failures: AttachmentFailure[];
      voiceCount: number;
    };

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
      log.debug("inbound", "voice transcript", { messageId: msg.messageId, transcriptLength: transcript.length });
      text = options.contentText ? `${options.contentText}\n${transcript}` : transcript;
    }
  }

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

const DEFAULT_MAX_PENDING_FILES = 10;
const DEFAULT_PENDING_TTL_MS = 10 * 60_000;

interface PendingFile {
  file: SavedFile;
  at: number;
}

interface PendingAttachmentsOptions {
  maxFiles?: number;
  ttlMs?: number;
  now?: () => number;
}

export class PendingAttachments {
  private files: PendingFile[] = [];
  private readonly maxFiles: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PendingAttachmentsOptions = {}) {
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_PENDING_FILES));
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_PENDING_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  get limit(): number {
    return this.maxFiles;
  }

  get count(): number {
    this.prune(this.now());
    return this.files.length;
  }

  add(files: SavedFile[]): { accepted: number; dropped: number } {
    if (files.length === 0) return { accepted: 0, dropped: 0 };
    const now = this.now();
    this.prune(now);
    this.files.push(...files.map((file) => ({ file, at: now })));
    const dropped = Math.max(0, this.files.length - this.maxFiles);
    if (dropped > 0) this.files.splice(0, dropped);
    return { accepted: files.length, dropped };
  }

  take(): SavedFile[] {
    this.prune(this.now());
    const files = this.files.map((entry) => entry.file);
    this.files = [];
    return files;
  }

  clear(): void {
    this.files = [];
  }

  private prune(now: number): void {
    if (this.ttlMs <= 0) return;
    this.files = this.files.filter((entry) => now - entry.at <= this.ttlMs);
  }
}
