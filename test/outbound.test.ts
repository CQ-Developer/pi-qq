import { describe, expect, it } from "vitest";
import { chunkText, markdownToPlain, TEXT_CHUNK_LIMIT } from "../src/outbound";
import { getSettings } from "../src/config";

describe("getSettings", () => {
  it("汇总帧默认 10s", () => {
    expect(getSettings({}).streamFlushMs).toBe(10_000);
  });

  it("streamFlushMs 可显式覆盖", () => {
    expect(getSettings({ streamFlushMs: 3000 }).streamFlushMs).toBe(3000);
  });
});

describe("markdownToPlain", () => {
  it("标题去 #", () => {
    expect(markdownToPlain("# 标题\n正文")).toBe("标题\n正文");
  });

  it("强调标记去除", () => {
    expect(markdownToPlain("**粗** 和 *斜* 与 __粗__")).toBe("粗 和 斜 与 粗");
  });

  it("行内代码去反引号", () => {
    expect(markdownToPlain("运行 `npm test` 看结果")).toBe("运行 npm test 看结果");
  });

  it("链接转 文字（url）", () => {
    expect(markdownToPlain("见 [文档](https://x.cn/a) 说明")).toBe("见 文档（https://x.cn/a） 说明");
  });

  it("文字与 url 相同只留 url", () => {
    expect(markdownToPlain("地址 [https://x.cn](https://x.cn)")).toBe("地址 https://x.cn");
  });

  it("图片保留 alt", () => {
    expect(markdownToPlain("![架构图](https://x.cn/i.png)")).toBe("架构图");
  });

  it("无序列表转 •、有序保留", () => {
    expect(markdownToPlain("- 项目一\n- 项目二\n1. 甲")).toBe("• 项目一\n• 项目二\n1. 甲");
  });

  it("引用去 >", () => {
    expect(markdownToPlain("> 引用内容")).toBe("引用内容");
  });

  it("表格逐行退化（分隔行丢弃）", () => {
    expect(markdownToPlain("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a | b\n1 | 2");
  });

  it("围栏内容原样保留", () => {
    expect(markdownToPlain("```\ncode **keep**\n```")).toBe("code **keep**");
  });

  it("水平线转空行", () => {
    expect(markdownToPlain("上文\n---\n下文")).toBe("上文\n\n下文");
  });

  it("删除线去除", () => {
    expect(markdownToPlain("~~删除~~")).toBe("删除");
  });

  it("下划线标识符不被误删", () => {
    expect(markdownToPlain("snake_case_word 保留")).toBe("snake_case_word 保留");
  });

  it("压缩多余空行", () => {
    expect(markdownToPlain("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("chunkText", () => {
  it("短文本不分块", () => {
    expect(chunkText("短文本")).toEqual(["短文本"]);
  });

  it("分块均不超限且无损拼接", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `第 ${i} 行内容 padding padding padding`).join("\n");
    const chunks = chunkText(lines, 200);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join("")).toBe(lines);
  });

  it("无换行硬切仍无损", () => {
    const noNewline = "x".repeat(1000);
    const hardChunks = chunkText(noNewline, 300);
    expect(hardChunks.join("")).toBe(noNewline);
    expect(hardChunks.length).toBe(4);
  });

  it("等于上限时不分块", () => {
    expect(chunkText("a".repeat(TEXT_CHUNK_LIMIT)).length).toBe(1);
  });
});
