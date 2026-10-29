/** QQ 图片附件 → pi ImageContent：类型/大小校验、带超时的受限下载。 */

export interface InboundAttachmentLike {
  content_type: string;
  url: string;
  filename?: string;
  size?: number;
}

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

/** 按 content_type 优先、文件名扩展名兜底，返回可注入的 mime；不支持返回 null。 */
export function resolveImageMime(contentType: string | undefined, filename: string | undefined): string | null {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type) {
    if (MIME_BY_CONTENT_TYPE[type]) return MIME_BY_CONTENT_TYPE[type];
    // 明确声明为 image/* 但不支持（如 svg）时拒绝，避免错误扩展名绕过校验
    if (type.startsWith("image/")) return null;
  }

  const ext = filename?.split(".").pop()?.toLowerCase();
  return ext ? (MIME_BY_EXTENSION[ext] ?? null) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** 文本 + 图片组合为 pi.sendUserMessage 的内容；无图片时保持纯字符串。 */
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
    successCount > 0
      ? `⚠️ 有 ${failures.length} 个附件未处理（成功 ${successCount} 个）：`
      : "⚠️ 附件处理失败：";
  return [title, ...failures.map((failure) => `• ${failure.filename}：${failure.reason}`)].join("\n");
}

function attachmentLabel(filename: string | undefined, index: number): string {
  const name = filename?.trim();
  return name || `图片 ${index + 1}`;
}

async function readBodyLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > limit) {
      throw new Error(`图片过大（${formatBytes(body.byteLength)} > ${formatBytes(limit)}）`);
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`图片过大（>${formatBytes(limit)}）`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("图片内容为空");
  return Buffer.concat(chunks, total);
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

  let parsed: URL;
  try {
    parsed = new URL(attachment.url);
  } catch {
    return { failure: { filename, reason: "图片地址无效" } };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { failure: { filename, reason: "不支持的图片地址协议" } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(parsed.toString(), { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      return { failure: { filename, reason: `下载失败（HTTP ${response.status}）` } };
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxSize) {
      await response.body?.cancel();
      return { failure: { filename, reason: `图片过大（${formatBytes(contentLength)} > ${formatBytes(maxSize)}）` } };
    }

    const body = await readBodyLimited(response, maxSize);
    return { image: { type: "image", data: body.toString("base64"), mimeType } };
  } catch (err) {
    const reason = controller.signal.aborted
      ? `下载超时（${DOWNLOAD_TIMEOUT_MS / 1000}s）`
      : err instanceof Error
        ? err.message
        : "下载失败";
    return { failure: { filename, reason } };
  } finally {
    clearTimeout(timer);
  }
}

/** 按原顺序下载所有附件；单张失败不影响其他图片。 */
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
