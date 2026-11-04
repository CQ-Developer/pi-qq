import { formatBytes } from "../infra/display-format";
import { t } from "../infra/i18n";

export interface InboundAttachmentLike {
  content_type: string;
  url: string;
  filename?: string;
  size?: number;
}

export interface DownloadOptions {
  url: string;
  maxSize: number;
  timeoutMs: number;
  kind: string;
  fetchImpl?: typeof fetch;
}

async function readBodyLimited(response: Response, limit: number, kind: string): Promise<Buffer> {
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > limit) {
      throw new Error(
        t("attachments.tooLarge", { kind, size: formatBytes(body.byteLength), limit: formatBytes(limit) }),
      );
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
        throw new Error(t("attachments.tooLargeShort", { kind, limit: formatBytes(limit) }));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error(t("attachments.empty", { kind }));
  return Buffer.concat(chunks, total);
}

export async function downloadLimited(opts: DownloadOptions): Promise<Buffer> {
  const limit = Math.max(1, opts.maxSize);
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new Error(t("attachments.invalidUrl", { kind: opts.kind }));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("attachments.unsupportedProtocol", { kind: opts.kind }));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(parsed.toString(), { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new Error(t("attachments.httpFailed", { status: response.status }));
    }

    const lengthHeader = response.headers.get("content-length");
    const contentLength = lengthHeader ? Number(lengthHeader) : NaN;
    if (Number.isFinite(contentLength) && contentLength > limit) {
      await response.body?.cancel();
      throw new Error(
        t("attachments.tooLarge", { kind: opts.kind, size: formatBytes(contentLength), limit: formatBytes(limit) }),
      );
    }
    return await readBodyLimited(response, limit, opts.kind);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(t("attachments.timeout", { seconds: opts.timeoutMs / 1000 }), { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
