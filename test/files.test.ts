import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatFilePrompt, sanitizeFilename, saveInboundFiles } from "../src/files";
import { getSettings } from "../src/config";

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

describe("formatFilePrompt", () => {
  const files = [{ path: "/tmp/a.zip", originalName: "a.zip", size: 1.5 * 1024 * 1024 }];

  it("包含路径、大小、原始名和用户消息", () => {
    expect(formatFilePrompt(files, "分析它")).toBe(
      "用户通过 QQ 发送了以下文件（已保存到本机，可用 read/bash 等工具访问）：\n" +
        "- /tmp/a.zip（1.5MB，原始名：a.zip）\n\n" +
        "用户消息：\n分析它",
    );
  });

  it("无文件时保持原文", () => {
    expect(formatFilePrompt([], "hello")).toBe("hello");
  });

  it("无文本时只输出文件块", () => {
    expect(formatFilePrompt(files, "  ")).not.toContain("用户消息");
  });
});

describe("saveInboundFiles", () => {
  it("下载并保存文件到日期/msgId 目录", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    try {
      const zip = Uint8Array.from([1, 2, 3, 4]);
      const result = await saveInboundFiles(
        [{ content_type: "application/zip", url: "https://example.com/test.zip", filename: "test.zip" }],
        {
          baseDir: base,
          dirKey: "msg-123",
          now: new Date(2026, 9, 29, 12),
          maxSize: 1024,
          fetchImpl: (async () =>
            new Response(zip, {
              headers: { "content-type": "application/zip", "content-length": String(zip.length) },
            })) as typeof fetch,
        },
      );

      expect(result.failures).toEqual([]);
      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.path).toContain(join("2026-10-29", "msg-123", "test.zip"));
      expect((await readFile(result.files[0]!.path)).equals(Buffer.from(zip))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("同名文件自动加后缀，路径不越界", async () => {
    const base = await mkdtemp(join(tmpdir(), "pi-qq-files-"));
    try {
      const result = await saveInboundFiles(
        [
          { content_type: "file", url: "https://example.com/evil.txt", filename: "../../evil.txt" },
          { content_type: "file", url: "https://example.com/evil2.txt", filename: "evil.txt" },
        ],
        {
          baseDir: base,
          dirKey: "..",
          maxSize: 1024,
          fetchImpl: (async () => new Response("x")) as typeof fetch,
        },
      );

      expect(result.failures).toEqual([]);
      expect(result.files).toHaveLength(2);
      const names = result.files.map((file) => file.path.split("/").pop());
      expect(new Set(names).size).toBe(2);
      expect(result.files.every((file) => file.path.startsWith(base))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("元数据超限时在下载前拒绝", async () => {
    let fetched = false;
    const result = await saveInboundFiles(
      [{ content_type: "file", url: "https://example.com/big.zip", filename: "big.zip", size: 99_999 }],
      {
        maxSize: 1024,
        fetchImpl: (async () => {
          fetched = true;
          return new Response();
        }) as typeof fetch,
      },
    );

    expect(result.files).toHaveLength(0);
    expect(fetched).toBe(false);
    expect(result.failures[0]?.reason).toContain("文件过大");
  });

  it("文件大小默认上限为 50MB", () => {
    expect(getSettings({}).fileMaxSize).toBe(50 * 1024 * 1024);
  });
});
