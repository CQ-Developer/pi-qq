/** QQ image attachments to pi ImageContent: validation and timeout-limited download. */
import { downloadLimited, type InboundAttachmentLike } from "./download";
import { formatBytes } from "./format";

export { formatBytes } from "./format";
export type { InboundAttachmentLike } from "./download";

export interface ImageContentLike {
  type: "image";
  data: string;
  mimeType: string;
}

export interface TextContentLike {
  type: "text";
  text: string;
}

export interface ImageFailure {
  filename: string;
  reason: string;
}

export interface ImageResolveResult {
  images: ImageContentLike[];
  failures: ImageFailure[];
}

const DOWNLOAD_TIMEOUT_MS = 15_000;

const MIME_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** Prefer content_type, fall back to extension; return injectable mime or null. */
export function resolveImageMime(contentType: string | undefined, filename: string | undefined): string | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type) {
    if (MIME_BY_CONTENT_TYPE[type]) return MIME_BY_CONTENT_TYPE[type];
    // Reject unsupported image/* types (e.g. svg) so a wrong extension cannot bypass validation.
    if (type.startsWith("image/")) return null;
  }

  const ext = filename?.split(".").pop()?.toLowerCase();
  return ext ? (MIME_BY_EXTENSION[ext] ?? null) : null;
}

/** Whether the attachment is an image (unsupported image/* is handled by the image path). */
export function isImageAttachment(attachment: InboundAttachmentLike): boolean {
  const type = (attachment.content_type ?? "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return resolveImageMime(attachment.content_type, attachment.filename) !== null;
}

/** Build pi.sendUserMessage content; keep a plain string when there are no images. */
export function buildImageMessageContent(
  text: string,
  images: readonly ImageContentLike[],
): string | (TextContentLike | ImageContentLike)[] {
  if (images.length === 0) return text;
  const content: (TextContentLike | ImageContentLike)[] = [];
  if (text) content.push({ type: "text", text });
  content.push(...images);
  return content;
}

export function formatImageFailures(failures: readonly ImageFailure[], successCount: number): string {
  const title =
    successCount > 0 ? `⚠️ 有 ${failures.length} 个附件未处理（成功 ${successCount} 个）：` : "⚠️ 附件处理失败：";
  return [title, ...failures.map((failure) => `• ${failure.filename}：${failure.reason}`)].join("\n");
}

function attachmentLabel(filename: string | undefined, index: number): string {
  const name = filename?.trim();
  return name || `图片 ${index + 1}`;
}

async function downloadOne(
  attachment: InboundAttachmentLike,
  index: number,
  maxSize: number,
  fetchImpl: typeof fetch,
): Promise<{ image?: ImageContentLike; failure?: ImageFailure }> {
  const filename = attachmentLabel(attachment.filename, index);
  const mimeType = resolveImageMime(attachment.content_type, attachment.filename);
  if (!mimeType) {
    return { failure: { filename, reason: `不支持的附件类型（${attachment.content_type || "未知"}）` } };
  }
  if (typeof attachment.size === "number" && attachment.size > maxSize) {
    return { failure: { filename, reason: `图片过大（${formatBytes(attachment.size)} > ${formatBytes(maxSize)}）` } };
  }

  try {
    const body = await downloadLimited({
      url: attachment.url,
      maxSize,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      kind: "图片",
      fetchImpl,
    });
    return { image: { type: "image", data: body.toString("base64"), mimeType } };
  } catch (err) {
    return { failure: { filename, reason: err instanceof Error ? err.message : "下载失败" } };
  }
}

/** Download images in order; one failure does not stop the others. */
export async function resolveInboundImages(
  attachments: readonly InboundAttachmentLike[],
  maxSize: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageResolveResult> {
  const limit = Math.max(1, maxSize);
  const results = await Promise.all(
    attachments.map((attachment, index) => downloadOne(attachment, index, limit, fetchImpl)),
  );

  const images: ImageContentLike[] = [];
  const failures: ImageFailure[] = [];
  for (const result of results) {
    if (result.image) images.push(result.image);
    if (result.failure) failures.push(result.failure);
  }
  return { images, failures };
}
