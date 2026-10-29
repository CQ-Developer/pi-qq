import { describe, expect, it } from "vitest";
import { formatTokenCount, formatUsageSummary, sumUsageMessages } from "../src/usage";

describe("formatTokenCount", () => {
  it("小于 1k", () => {
    expect(formatTokenCount(999)).toBe("999");
  });

  it("整千省略 .0", () => {
    expect(formatTokenCount(1000)).toBe("1k");
  });

  it("一位小数", () => {
    expect(formatTokenCount(12_345)).toBe("12.3k");
  });

  it("200k", () => {
    expect(formatTokenCount(200_000)).toBe("200k");
  });
});

describe("formatUsageSummary", () => {
  it("严格三行格式（输入=总输入，括号=累计缓存命中率）", () => {
    expect(
      formatUsageSummary({
        usage: { input: 4, output: 2_300, cacheRead: 4_096, cacheWrite: 0 },
        context: { tokens: 4_100, contextWindow: 1_048_600, percent: 0.4 },
      }),
    ).toBe("📊 用量摘要\n• 输入：4.1k (99.9%)\n• 输出：2.3k\n• 上下文：0.4%");
  });

  it("无缓存/上下文时显示 0.0%/未知", () => {
    expect(
      formatUsageSummary({
        usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toBe("📊 用量摘要\n• 输入：500 (0.0%)\n• 输出：20\n• 上下文：未知");
  });

  it("cacheWrite 计入总输入；压缩后显示重建中", () => {
    expect(
      formatUsageSummary({
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 50 },
        context: { tokens: null, contextWindow: 1_048_600, percent: null },
      }),
    ).toBe("📊 用量摘要\n• 输入：200 (25.0%)\n• 输出：20\n• 上下文：重建中");
  });

  it("上下文 percent 缺失时按 tokens/window 计算", () => {
    expect(
      formatUsageSummary({
        usage: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 },
        context: { tokens: 500, contextWindow: 2_000, percent: null },
      }),
    ).toBe("📊 用量摘要\n• 输入：500 (0.0%)\n• 输出：20\n• 上下文：25.0%");
  });
});

describe("sumUsageMessages", () => {
  const usage = (input: number, output: number, cacheRead: number) => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  });

  it("汇总本次 run 的 assistant + toolResult 嵌套 usage", () => {
    const messages = [
      { role: "assistant", usage: usage(4, 1_000, 2_000) },
      { role: "toolResult", usage: usage(3, 100, 96) },
      { role: "user" },
      { role: "assistant", usage: usage(1, 50, 0) },
    ];
    expect(sumUsageMessages(messages as never)).toEqual({
      input: 8,
      output: 1_150,
      cacheRead: 2_096,
      cacheWrite: 0,
    });
  });
});
