import { beforeEach, describe, expect, it } from "vitest";
import { configureI18n } from "../../src/infra/i18n";
import { getSettings, parseConfig } from "../../src/infra/settings";

beforeEach(() => configureI18n("en-us"));

describe("parseConfig", () => {
  it("rejects non-object JSON roots", () => {
    for (const raw of [null, [], "text", 42]) {
      const { config, error } = parseConfig(raw);
      expect(config).toEqual({});
      expect(error).toContain("expected a JSON object");
    }
  });

  it("keeps valid fields and reports invalid ones", () => {
    const { config, error } = parseConfig({
      thinkingRelay: "yes",
      deliverAs: "bogus",
      fileMaxSize: "large",
      logLevel: "verbose",
      debug: true,
    });

    expect(config).toEqual({ debug: true });
    expect(error).toContain("thinkingRelay");
    expect(error).toContain("deliverAs");
    expect(error).toContain("fileMaxSize");
    expect(error).toContain("logLevel");
  });

  it("accepts a fully valid config", () => {
    const raw = {
      thinkingRelay: false,
      deliverAs: "followUp",
      fileMaxSize: 2048,
      logLevel: "debug",
      language: "en-us",
    } as const;
    expect(parseConfig(raw)).toEqual({ config: raw });
  });

  it("defaults language to zh-cn and rejects invalid values", () => {
    expect(getSettings({}).language).toBe("zh-cn");
    expect(getSettings({ language: "en-us" }).language).toBe("en-us");
    const { config, error } = parseConfig({ language: "fr-fr" });
    expect(config).toEqual({});
    expect(error).toContain("language");
  });
});

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
      imageMaxSize: 1024,
    } as never);
    expect(settings).toEqual({
      thinkingRelay: true,
      deliverAs: "steer",
      replyType: "full",
      fileMaxSize: 50 * 1024 * 1024,
      logLevel: "silent",
      language: "zh-cn",
    });
  });
});

describe("replyType settings", () => {
  it("默认为 full", () => {
    expect(getSettings({}).replyType).toBe("full");
  });

  it("接受合法取值", () => {
    expect(getSettings({ replyType: "full" }).replyType).toBe("full");
    expect(getSettings({ replyType: "simple" }).replyType).toBe("simple");
    expect(getSettings({ replyType: "last" }).replyType).toBe("last");
  });

  it("解析时保留合法取值", () => {
    expect(parseConfig({ replyType: "full" })).toEqual({ config: { replyType: "full" } });
    expect(parseConfig({ replyType: "last" })).toEqual({ config: { replyType: "last" } });
  });

  it("忽略非法取值并报错", () => {
    const { config, error } = parseConfig({ replyType: "verbose" });
    expect(config).toEqual({});
    expect(error).toContain("replyType");

    const numeric = parseConfig({ replyType: 1 });
    expect(numeric.config).toEqual({});
    expect(numeric.error).toContain("replyType");
  });

  it("非法取值在解析阶段被丢弃，最终回退到默认模式", () => {
    const { config } = parseConfig({ replyType: "verbose" });
    expect(getSettings(config).replyType).toBe("full");
  });
});
