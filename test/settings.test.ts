import { describe, expect, it } from "vitest";
import { getSettings } from "../src/settings";

describe("logLevel settings", () => {
  it("defaults to silent", () => {
    expect(getSettings({}).logLevel).toBe("silent");
    expect(getSettings({ debug: false }).logLevel).toBe("silent");
  });

  it("accepts an explicit level", () => {
    expect(getSettings({ logLevel: "info" }).logLevel).toBe("info");
    expect(getSettings({ logLevel: "debug" }).logLevel).toBe("debug");
  });

  it("migrates legacy debug=true", () => {
    expect(getSettings({ debug: true }).logLevel).toBe("debug");
  });

  it("prefers logLevel over legacy debug", () => {
    expect(getSettings({ logLevel: "warn", debug: true }).logLevel).toBe("warn");
  });

  it("falls back to silent for invalid levels", () => {
    expect(getSettings({ logLevel: "verbose" as never }).logLevel).toBe("silent");
  });
});

describe("getSettings", () => {
  it("thinkingRelay 默认开启", () => {
    expect(getSettings({}).thinkingRelay).toBe(true);
  });

  it("thinkingRelay 可显式关闭", () => {
    expect(getSettings({ thinkingRelay: false }).thinkingRelay).toBe(false);
  });

  it("旧配置键被忽略", () => {
    const settings = getSettings({
      streamFlushMs: 3000,
      streamAssistant: true,
      streamRelay: true,
      markdownSupport: true,
      heartbeatMinutes: 10,
      heartbeatMaxMessages: 3,
    } as never);
    expect(settings).toEqual({
      thinkingRelay: true,
      deliverAs: "steer",
      imageMaxSize: 10 * 1024 * 1024,
      fileMaxSize: 50 * 1024 * 1024,
      logLevel: "silent",
    });
  });
});
