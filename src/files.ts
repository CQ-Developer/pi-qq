/** Save QQ non-image attachments in the workspace, with session-scoped deduplication. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { downloadLimited, type InboundAttachmentLike } from "./download";
import { formatBytes } from "./format";
import { log } from "./logger";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_INDEX_FILENAME = ".index.json";

export interface SavedFile {
  path: string;
  originalName: string;
  size: number;
}

export interface FileFailure {
  filename: string;
  reason: string;
}

/** fileName -> SHA-256. Paths are derived from uploadDir. */
export type UploadIndex = Record<string, string>;

export interface SaveFilesOptions {
  maxSize: number;
  /** `<cwd>/.pi/pi-qq/<sessionId>/uploads`. */
  uploadDir: string;
  /** Test/caller override; loaded from uploadDir when omitted. Mutated in place. */
  index?: UploadIndex;
  fetchImpl?: typeof fetch;
}

export interface SaveFilesResult {
  files: SavedFile[];
  failures: FileFailure[];
}

function safePathSegment(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+|[._]+$/g, "");
  return cleaned.slice(0, 64) || "session";
}

/** Session-scoped upload directory; no date or msgId subdirectories. */
export function sessionUploadDir(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "pi-qq", safePathSegment(sessionId), "uploads");
}

export function uploadIndexPath(uploadDir: string): string {
  return join(uploadDir, UPLOAD_INDEX_FILENAME);
}

/** Keep only a safe basename (no paths/control/Windows-invalid chars); truncate long stems. */
export function sanitizeFilename(filename: string | undefined, fallback: string): string {
  const raw = basename((filename ?? "").trim());
  const cleaned = raw
    // Control characters are rejected intentionally when normalizing a filename.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;

  const ext = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length);
  const maxStemLength = Math.max(1, 120 - ext.length);
  return `${stem.slice(0, maxStemLength)}${ext}`;
}

function withSuffix(filename: string, suffix: number): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  return `${stem}-${suffix}${ext}`;
}

function isSafeIndexKey(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename !== "." &&
    filename !== ".." &&
    filename !== UPLOAD_INDEX_FILENAME &&
    basename(filename) === filename
  );
}

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function loadUploadIndex(uploadDir: string): Promise<UploadIndex> {
  try {
    const parsed = JSON.parse(await readFile(uploadIndexPath(uploadDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const index: UploadIndex = {};
    for (const [filename, hash] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSafeIndexKey(filename) && typeof hash === "string") index[filename] = hash;
    }
    return index;
  } catch {
    return {};
  }
}

async function persistUploadIndex(uploadDir: string, index: UploadIndex): Promise<void> {
  const path = uploadIndexPath(uploadDir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(uploadDir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  } catch (err) {
    log.warn("files", "failed to write upload index", { path, err });
  }
}

/** Load the index and drop entries whose files no longer exist. No content hashing. */
export async function pruneUploadIndex(uploadDir: string): Promise<UploadIndex> {
  const index = await loadUploadIndex(uploadDir);
  let changed = false;
  for (const filename of Object.keys(index)) {
    if (!(await isFile(join(uploadDir, filename)))) {
      delete index[filename];
      changed = true;
    }
  }
  if (changed) await persistUploadIndex(uploadDir, index);
  return index;
}

async function hashExistingFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

async function saveOrReuse(
  uploadDir: string,
  filename: string,
  body: Buffer,
  index: UploadIndex,
): Promise<{ file: SavedFile; changed: boolean }> {
  const hash = sha256Hex(body);
  const target = join(uploadDir, filename);
  let changed = false;

  if (!(await isFile(target))) {
    // A stale index entry must not make a missing file look reusable.
    if (index[filename]) {
      delete index[filename];
    }
    await writeFile(target, body, { flag: "wx" });
    index[filename] = hash;
    return { file: { path: target, originalName: filename, size: body.byteLength }, changed: true };
  }

  let existingHash = index[filename];
  if (!existingHash) {
    existingHash = await hashExistingFile(target);
    index[filename] = existingHash;
    changed = true;
  }
  if (existingHash === hash) {
    return { file: { path: target, originalName: filename, size: body.byteLength }, changed };
  }

  for (let suffix = 1; suffix < 100; suffix++) {
    const candidate = withSuffix(filename, suffix);
    const candidatePath = join(uploadDir, candidate);
    if (await isFile(candidatePath)) {
      let candidateHash = index[candidate];
      if (!candidateHash) {
        candidateHash = await hashExistingFile(candidatePath);
        index[candidate] = candidateHash;
        changed = true;
      }
      if (candidateHash === hash) {
        return { file: { path: candidatePath, originalName: candidate, size: body.byteLength }, changed };
      }
      continue;
    }

    if (index[candidate]) {
      delete index[candidate];
    }
    await writeFile(candidatePath, body, { flag: "wx" });
    index[candidate] = hash;
    return { file: { path: candidatePath, originalName: candidate, size: body.byteLength }, changed: true };
  }

  throw new Error("Could not allocate a unique filename");
}

/** Save non-image attachments in order; one failure does not stop the others. */
export async function saveInboundFiles(
  attachments: readonly InboundAttachmentLike[],
  options: SaveFilesOptions,
): Promise<SaveFilesResult> {
  const uploadDir = options.uploadDir;
  const limit = Math.max(1, options.maxSize);
  const fetchImpl = options.fetchImpl ?? fetch;
  const index = options.index ?? (await loadUploadIndex(uploadDir));
  const files: SavedFile[] = [];
  const failures: FileFailure[] = [];
  const seenPaths = new Set<string>();
  let indexChanged = false;

  if (attachments.length > 0) await mkdir(uploadDir, { recursive: true });

  const addFile = (file: SavedFile) => {
    if (seenPaths.has(file.path)) return;
    seenPaths.add(file.path);
    files.push(file);
  };

  for (const [position, attachment] of attachments.entries()) {
    const fallback = `file-${position + 1}`;
    const filename = sanitizeFilename(attachment.filename, fallback);
    if (typeof attachment.size === "number" && attachment.size > limit) {
      failures.push({ filename, reason: `file too large (${formatBytes(attachment.size)} > ${formatBytes(limit)})` });
      continue;
    }

    try {
      const body = await downloadLimited({
        url: attachment.url,
        maxSize: limit,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        kind: "file",
        fetchImpl,
      });
      const result = await saveOrReuse(uploadDir, filename, body, index);
      indexChanged ||= result.changed;
      addFile(result.file);
    } catch (err) {
      failures.push({ filename, reason: err instanceof Error ? err.message : "Download failed" });
    }
  }

  if (indexChanged) await persistUploadIndex(uploadDir, index);
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
