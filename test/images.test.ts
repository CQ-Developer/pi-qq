import { describe, expect, it } from "vitest";
import {
  buildImageMessageContent,
  formatBytes,
  formatImageFailures,
  resolveImageMime,
  resolveInboundImages,
  type ImageContentLike,
} from "../src/images";

const sampleImage: ImageContentLike = { type: "image", data: "AAA", mimeType: "image/png" };

describe("resolveImageMime", () => {
  it("jpeg", () => {
    expect(resolveImageMime("image/jpeg", "a.jpg")).toBe("image/jpeg");
  });

  it("image/jpg 归一化", () => {
    expect(resolveImageMime("image/jpg", "a.jpg")).toBe("image/jpeg");
  });

  it("忽略 content_type 参数", () => {
    expect(resolveImageMime("image/png; charset=binary", "a")).toBe("image/png");
  });

  it("按扩展名兜底", () => {
    expect(resolveImageMime("application/octet-stream", "b.PNG")).toBe("image/png");
  });

  it("明确 image/* 不支持时拒绝", () => {
    expect(resolveImageMime("image/svg+xml", "evil.png")).toBeNull();
  });

  it("未知类型拒绝", () => {
    expect(resolveImageMime("text/plain", "noext")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("MB 格式", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0MB");
  });
});

describe("buildImageMessageContent", () => {
  it("无图片时保持字符串", () => {
    expect(buildImageMessageContent("hi", [])).toBe("hi");
  });

  it("仅图片", () => {
    expect(buildImageMessageContent("", [sampleImage])).toEqual([sampleImage]);
  });

  it("文本 + 图片保持顺序", () => {
    expect(buildImageMessageContent("hi", [sampleImage])).toEqual([{ type: "text", text: "hi" }, sampleImage]);
  });
});

describe("formatImageFailures", () => {
  it("全部失败", () => {
    expect(formatImageFailures([{ filename: "a.png", reason: "过大" }], 0)).toBe("⚠️ 附件处理失败：\n• a.png：过大");
  });

  it("部分成功", () => {
    expect(formatImageFailures([{ filename: "a.png", reason: "过大" }], 1)).toBe(
      "⚠️ 有 1 个附件未处理（成功 1 个）：\n• a.png：过大",
    );
  });
});

describe("resolveInboundImages", () => {
  it("成功下载并转 base64", async () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const result = await resolveInboundImages(
      [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
      1024,
      (async () =>
        new Response(png, {
          headers: { "content-type": "image/png", "content-length": String(png.length) },
        })) as typeof fetch,
    );
    expect(result.failures).toEqual([]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.data).toBe(Buffer.from(png).toString("base64"));
  });

  it("元数据超限时在下载前拒绝", async () => {
    let fetched = false;
    const result = await resolveInboundImages(
      [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png", size: 99_999 }],
      1024,
      (async () => {
        fetched = true;
        return new Response();
      }) as typeof fetch,
    );
    expect(result.images).toHaveLength(0);
    expect(fetched).toBe(false);
    expect(result.failures[0]?.reason).toContain("图片过大");
  });

  it("实际内容超限时流式拒绝", async () => {
    const big = new Uint8Array(32);
    const result = await resolveInboundImages(
      [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
      10,
      (async () => new Response(big, { headers: { "content-type": "image/png" } })) as typeof fetch,
    );
    expect(result.images).toHaveLength(0);
    expect(result.failures[0]?.reason).toContain("图片过大");
  });

  it("不支持类型不注入", async () => {
    const result = await resolveInboundImages(
      [{ content_type: "image/svg+xml", url: "https://example.com/a.svg", filename: "a.svg" }],
      1024,
      (async () => new Response()) as typeof fetch,
    );
    expect(result.images).toHaveLength(0);
    expect(result.failures[0]?.reason).toContain("不支持的附件类型");
  });
});
