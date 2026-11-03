import { describe, expect, it } from "vitest";
import { formatBytes, formatTokenCount } from "../../src/infra/display-format";

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

describe("formatBytes", () => {
  it("MB 格式", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0MB");
  });
});
