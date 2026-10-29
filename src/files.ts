/** Save QQ non-image attachments in the workspace and reference them in the prompt. */
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
  /** Test override; defaults to <cwd>/.pi/pi-qq. */
  baseDir?: string;
  /** Directory key for one message (usually msgId). */
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

/** Keep only a safe basename (no paths/control/Windows-invalid chars); truncate long stems. */
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

/** Save non-image attachments in order; one failure does not stop the others. */
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

/** Combine saved paths and the original user message into the pi prompt. */
export function formatFilePrompt(files: readonly SavedFile[], userText: string): string {
  if (files.length === 0) return userText;

  const lines = [
    "User sent the following file(s) via QQ (saved locally; use read/bash or other tools to access):",
    ...files.map((file) => `- ${file.path} (${formatBytes(file.size)}, original name: ${file.originalName})`),
  ];
  const text = userText.trim();
  if (text) lines.push("", "User message:", text);
  return lines.join("\n");
}
