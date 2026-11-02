import type { InboundAttachmentLike } from "./download";

export interface VoiceAttachmentLike extends InboundAttachmentLike {
  asr_refer_text?: string;
}

export function isVoiceAttachment(attachment: { content_type?: string }): boolean {
  return (attachment.content_type ?? "").toLowerCase() === "voice";
}

export function resolveVoiceTranscript(attachments: readonly VoiceAttachmentLike[]): string | undefined {
  const transcripts: string[] = [];
  for (const attachment of attachments) {
    if (!isVoiceAttachment(attachment)) continue;
    const text = attachment.asr_refer_text?.trim();
    if (text) transcripts.push(text);
  }
  return transcripts.length > 0 ? transcripts.join("\n") : undefined;
}
