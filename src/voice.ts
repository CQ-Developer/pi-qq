/** QQ voice attachments: identify voice messages and extract platform ASR text. */
import type { InboundAttachmentLike } from "./download";

export interface VoiceAttachmentLike extends InboundAttachmentLike {
  asr_refer_text?: string;
}

/** A QQ voice message has content_type "voice"; other media/file types are excluded. */
export function isVoiceAttachment(attachment: { content_type?: string }): boolean {
  return (attachment.content_type ?? "").toLowerCase() === "voice";
}

/**
 * Collect non-empty ASR text from voice attachments in order.
 * Returns undefined when no attachment has a usable transcript.
 */
export function resolveVoiceTranscript(attachments: readonly VoiceAttachmentLike[]): string | undefined {
  const transcripts: string[] = [];
  for (const attachment of attachments) {
    if (!isVoiceAttachment(attachment)) continue;
    const text = attachment.asr_refer_text?.trim();
    if (text) transcripts.push(text);
  }
  return transcripts.length > 0 ? transcripts.join("\n") : undefined;
}
