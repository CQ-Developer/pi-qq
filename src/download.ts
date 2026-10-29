import { formatBytes } from "./format";

/** Minimal QQ inbound attachment shape shared by images and files. */
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
  /** Kind label used in errors, e.g. "image" or "file". */
  kind: string;
  fetchImpl?: typeof fetch;
}

async function readBodyLimited(response: Response, limit: number, kind: string): Promise<Buffer> {
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > limit) {
      throw new Error(`${kind} too large (${formatBytes(body.byteLength)} > ${formatBytes(limit)})`);
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
        throw new Error(`${kind} too large (>${formatBytes(limit)})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error(`empty ${kind} content`);
  return Buffer.concat(chunks, total);
}

/** Download an attachment with a timeout and streaming size cap. */
export async function downloadLimited(opts: DownloadOptions): Promise<Buffer> {
  const limit = Math.max(1, opts.maxSize);
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new Error(`invalid ${opts.kind} URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported ${opts.kind} URL protocol`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(parsed.toString(), { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new Error(`download failed (HTTP ${response.status})`);
    }

    const lengthHeader = response.headers.get("content-length");
    const contentLength = lengthHeader ? Number(lengthHeader) : NaN;
    if (Number.isFinite(contentLength) && contentLength > limit) {
      await response.body?.cancel();
      throw new Error(`${opts.kind} too large (${formatBytes(contentLength)} > ${formatBytes(limit)})`);
    }
    return await readBodyLimited(response, limit, opts.kind);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`download timed out after ${opts.timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
