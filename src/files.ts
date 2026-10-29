/** QQ 非图片附件 → 当前工作空间保存，并在提示词中给出路径供 pi 使用。 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { downloadLimited, type InboundAttachmentLike } from "./download";
import { formatBytes } from "./format";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_DIR = join(process.cwd(), ".pi", "pi-qq");

export interface SavedFile {
  path: string;
  originalName: string;
  size: number;
}

export interface FileFailure {
  filename: string;
  reason: string;
}

export interface SaveFilesOptions {
  maxSize: number;
  /** 测试可覆盖；默认 <cwd>/.pi/pi-qq */
  baseDir?: string;
  /** 用于隔离同一消息的文件目录（通常传 msgId） */
  dirKey?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}

export interface SaveFilesResult {
  files: SavedFile[];
  failures: FileFailure[];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateStamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function withSuffix(filename: string, suffix: number): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem}-${suffix}${ext}`;
}

/** 只保留安全文件名（去掉路径、控制符和 Windows 非法字符），超长时截断 stem。 */
export function sanitizeFilename(filename: string | undefined, fallback: string): string {
  const raw = basename((filename ?? "").trim());
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;

  const ext = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length);
  const maxStemLength = Math.max(1, 120 - ext.length);
  return `${stem.slice(0, maxStemLength)}${ext}`;
}

function safeDirKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+|[._]+$/g, "");
  return cleaned.slice(0, 64) || "msg";
}

async function writeUnique(dir: string, filename: string, body: Buffer): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = attempt === 0 ? filename : withSuffix(filename, attempt);
    const path = join(dir, candidate);
    try {
      await writeFile(path, body, { flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("无法分配唯一文件名");
}

/** 将非图片附件按原顺序保存到本地，单文件失败不影响其他文件。 */
export async function saveInboundFiles(
  attachments: readonly InboundAttachmentLike[],
  options: SaveFilesOptions,
): Promise<SaveFilesResult> {
  const now = options.now ?? new Date();
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
  const dir = options.dirKey
    ? join(baseDir, dateStamp(now), safeDirKey(options.dirKey))
    : join(baseDir, dateStamp(now));
  const limit = Math.max(1, options.maxSize);
  const fetchImpl = options.fetchImpl ?? fetch;

  const files: SavedFile[] = [];
  const failures: FileFailure[] = [];
  if (attachments.length > 0) await mkdir(dir, { recursive: true });

  for (const [index, attachment] of attachments.entries()) {
    const fallback = `file-${index + 1}`;
    const filename = sanitizeFilename(attachment.filename, fallback);
    if (typeof attachment.size === "number" && attachment.size > limit) {
      failures.push({ filename, reason: `文件过大（${formatBytes(attachment.size)} > ${formatBytes(limit)}）` });
      continue;
    }

    try {
      const body = await downloadLimited({
        url: attachment.url,
        maxSize: limit,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        kind: "文件",
        fetchImpl,
      });
      const path = await writeUnique(dir, filename, body);
      files.push({ path, originalName: filename, size: body.byteLength });
    } catch (err) {
      failures.push({ filename, reason: err instanceof Error ? err.message : "下载失败" });
    }
  }

  return { files, failures };
}

/** 将保存路径与用户原消息组合成 pi 提示词。 */
export function formatFilePrompt(files: readonly SavedFile[], userText: string): string {
  if (files.length === 0) return userText;

  const lines = [
    "用户通过 QQ 发送了以下文件（已保存到本机，可用 read/bash 等工具访问）：",
    ...files.map((file) => `- ${file.path}（${formatBytes(file.size)}，原始名：${file.originalName}）`),
  ];
  const text = userText.trim();
  if (text) lines.push("", "用户消息：", text);
  return lines.join("\n");
}
