import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatFilePrompt,
  pruneUploadIndex,
  sanitizeFilename,
  saveInboundFiles,
  sessionUploadDir,
  sha256Hex,
  uploadIndexPath,
} from "../src/files";
import { getSettings } from "../src/config";

function bodyInit(body: string | Uint8Array): string | ArrayBuffer {
  return typeof body === "string"
    ? body
    : (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
}

function fetchBody(body: string | Uint8Array): typeof fetch {
  return (async () => new Response(bodyInit(body))) as typeof fetch;
}

function fetchByUrl(bodies: Record<string, string | Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => new Response(bodyInit(bodies[String(input)] ?? ""))) as typeof fetch;
}

async function readIndex(uploadDir: string): Promise<Record<string, string>> {
  return JSON.parse(await readFile(uploadIndexPath(uploadDir), "utf8")) as Record<string, string>;
}

describe("sanitizeFilename", () => {
  it("去掉路径，只保留 basename", () => {
    expect(sanitizeFilename("../../etc/passwd", "file-1")).toBe("passwd");
  });

  it("清理非法字符", () => {
    expect(sanitizeFilename("a:b?.txt", "file-1")).toBe("a_b_.txt");
  });

  it("空名字使用 fallback", () => {
    expect(sanitizeFilename("..", "file-2")).toBe("file-2");
    expect(sanitizeFilename(undefined, "file-3")).toBe("file-3");
  });
});

describe("sessionUploadDir", () => {
  it("uses the session id and no date directory", () => {
    expect(sessionUploadDir("/workspace", "session-1")).toBe("/workspace/.pi/pi-qq/session-1/uploads");
  });
});

describe("formatFilePrompt", () => {
  const files = [{ path: "/tmp/a.zip", originalName: "a.zip", size: 1.5 * 1024 * 1024 }];

  it("包含路径、大小、原始名和用户消息", () => {
    expect(formatFilePrompt(files, "分析它")).toBe(
      "User sent the following file(s) via QQ (saved locally; use read/bash or other tools to access):\n" +
        "- /tmp/a.zip (1.5MB, original name: a.zip)\n\n" +
        "User message:\n分析它",
    );
  });

  it("无文件时保持原文", () => {
    expect(formatFilePrompt([], "hello")).toBe("hello");
  });

  it("无文本时只输出文件块", () => {
    expect(formatFilePrompt(files, "  ")).not.toContain("User message:");
  });
});

describe("saveInboundFiles", () => {
  it("saves a file into the session uploads directory and indexes its hash", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "session", "uploads");
    try {
      const zip = Uint8Array.from([1, 2, 3, 4]);
      const result = await saveInboundFiles(
        [{ content_type: "application/zip", url: "https://example.com/test.zip", filename: "test.zip" }],
        { uploadDir, maxSize: 1024, fetchImpl: fetchBody(zip) },
      );

      expect(result.failures).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.path).toBe(join(uploadDir, "test.zip"));
      expect((await readFile(result.files[0]!.path)).equals(Buffer.from(zip))).toBe(true);
      expect(await readIndex(uploadDir)).toEqual({ "test.zip": sha256Hex(Buffer.from(zip)) });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("reuses the same file for the same name and content", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      const attachment = { content_type: "file", url: "https://example.com/a.txt", filename: "a.txt" };
      const first = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("same") });
      const second = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("same") });

      expect(second.files[0]?.path).toBe(first.files[0]?.path);
      expect((await readdir(uploadDir)).filter((name) => name === "a.txt")).toHaveLength(1);
      expect(await readIndex(uploadDir)).toEqual({ "a.txt": sha256Hex(Buffer.from("same")) });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("uses a suffix when the name is reused with different content", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      const attachment = { content_type: "file", url: "https://example.com/a.txt", filename: "a.txt" };
      const first = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("first") });
      const second = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("second") });

      expect(first.files[0]?.path).toBe(join(uploadDir, "a.txt"));
      expect(second.files[0]?.path).toBe(join(uploadDir, "a-1.txt"));
      expect(await readIndex(uploadDir)).toEqual({
        "a.txt": sha256Hex(Buffer.from("first")),
        "a-1.txt": sha256Hex(Buffer.from("second")),
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("reuses as existing suffix when the same content is uploaded again", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      const attachment = { content_type: "file", url: "https://example.com/a.txt", filename: "a.txt" };
      await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("first") });
      const second = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("second") });
      const third = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("second") });

      expect(second.files[0]?.path).toBe(join(uploadDir, "a-1.txt"));
      expect(third.files[0]?.path).toBe(join(uploadDir, "a-1.txt"));
      expect((await readdir(uploadDir)).filter((name) => name === "a-1.txt")).toHaveLength(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("saves different names with identical content separately", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      const result = await saveInboundFiles(
        [
          { content_type: "file", url: "https://example.com/a.txt", filename: "a.txt" },
          { content_type: "file", url: "https://example.com/b.txt", filename: "b.txt" },
        ],
        {
          uploadDir,
          maxSize: 1024,
          fetchImpl: fetchByUrl({ "https://example.com/a.txt": "same", "https://example.com/b.txt": "same" }),
        },
      );

      expect(result.files.map((file) => file.path)).toEqual([join(uploadDir, "a.txt"), join(uploadDir, "b.txt")]);
      expect(await readIndex(uploadDir)).toEqual({
        "a.txt": sha256Hex(Buffer.from("same")),
        "b.txt": sha256Hex(Buffer.from("same")),
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("prunes index entries whose files were deleted", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      const attachment = { content_type: "file", url: "https://example.com/a.txt", filename: "a.txt" };
      const saved = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("same") });
      await rm(saved.files[0]!.path);

      await pruneUploadIndex(uploadDir);
      expect(await readIndex(uploadDir)).toEqual({});
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("recomputes an existing file hash when the index is missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      const attachment = { content_type: "file", url: "https://example.com/a.txt", filename: "a.txt" };
      const first = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("same") });
      await rm(uploadIndexPath(uploadDir));

      const second = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("same") });
      expect(second.files[0]?.path).toBe(first.files[0]?.path);
      expect(await readIndex(uploadDir)).toEqual({ "a.txt": sha256Hex(Buffer.from("same")) });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("recovers from a corrupt index on the next duplicate-name save", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      const attachment = { content_type: "file", url: "https://example.com/a.txt", filename: "a.txt" };
      await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("same") });
      await writeFile(uploadIndexPath(uploadDir), "not json");

      const second = await saveInboundFiles([attachment], { uploadDir, maxSize: 1024, fetchImpl: fetchBody("same") });
      expect(second.files[0]?.path).toBe(join(uploadDir, "a.txt"));
      expect(await readIndex(uploadDir)).toEqual({ "a.txt": sha256Hex(Buffer.from("same")) });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("元数据超限时在下载前拒绝", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    const uploadDir = join(base, "uploads");
    try {
      let fetched = false;
      const result = await saveInboundFiles(
        [{ content_type: "file", url: "https://example.com/big.zip", filename: "big.zip", size: 99_999 }],
        {
          uploadDir,
          maxSize: 1024,
          fetchImpl: (async () => {
            fetched = true;
            return new Response();
          }) as typeof fetch,
        },
      );

      expect(result.files).toHaveLength(0);
      expect(fetched).toBe(false);
      expect(result.failures[0]?.reason).toContain("file too large");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("文件大小默认上限为 50MB", () => {
    expect(getSettings({}).fileMaxSize).toBe(50 * 1024 * 1024);
  });
});
