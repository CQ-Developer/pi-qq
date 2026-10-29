import { formatBytes } from "./format";

/** QQ 入站附件的最小结构（图片与文件共用）。 */
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
  /** 错误文案中的类型名，如“图片”/“文件” */
  kind: string;
  fetchImpl?: typeof fetch;
}

async function readBodyLimited(response: Response, limit: number, kind: string): Promise<Buffer> {
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > limit) {
      throw new Error(`${kind}过大（${formatBytes(body.byteLength)} > ${formatBytes(limit)}）`);
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
        throw new Error(`${kind}过大（>${formatBytes(limit)}）`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error(`${kind}内容为空`);
  return Buffer.concat(chunks, total);
}

/** 带超时与流式大小上限的附件下载。 */
export async function downloadLimited(opts: DownloadOptions): Promise<Buffer> {
  const limit = Math.max(1, opts.maxSize);
  let parsed: URL;
  try {
    parsed = new URL(opts.url);
  } catch {
    throw new Error(`${opts.kind}地址无效`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`不支持的${opts.kind}地址协议`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(parsed.toString(), { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${response.status}）`);
    }

    const lengthHeader = response.headers.get("content-length");
    const contentLength = lengthHeader ? Number(lengthHeader) : NaN;
    if (Number.isFinite(contentLength) && contentLength > limit) {
      await response.body?.cancel();
      throw new Error(`${opts.kind}过大（${formatBytes(contentLength)} > ${formatBytes(limit)}）`);
    }
    return await readBodyLimited(response, limit, opts.kind);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`下载超时（${opts.timeoutMs / 1000}s）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
