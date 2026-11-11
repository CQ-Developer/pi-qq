import { afterEach, describe, expect, it } from "vitest";
import { configureI18n, DEFAULT_LANGUAGE, getLanguage, isLanguage, localizeLogMessage, t } from "../../src/infra/i18n";

afterEach(() => configureI18n(DEFAULT_LANGUAGE));

describe("i18n", () => {
  it("defaults to zh-cn", () => {
    configureI18n(DEFAULT_LANGUAGE);
    expect(getLanguage()).toBe("zh-cn");
    expect(t("status.title")).toBe("pi-qq 状态");
    expect(t("commands.help.stop")).toContain("中止");
  });

  it("switches to en-us", () => {
    configureI18n("en-us");
    expect(getLanguage()).toBe("en-us");
    expect(t("status.title")).toBe("pi-qq status");
    expect(t("commands.help.stop")).toContain("abort");
  });

  it("interpolates parameters", () => {
    configureI18n("en-us");
    expect(t("attachments.tooLarge", { kind: "file", size: "2MB", limit: "1MB" })).toBe("file too large (2MB > 1MB)");
    configureI18n("zh-cn");
    expect(t("attachments.tooLarge", { kind: "文件", size: "2MB", limit: "1MB" })).toBe("文件过大（2MB > 1MB）");
  });

  it("localizes media tool messages", () => {
    configureI18n("en-us");
    expect(t("mediaTool.kindImage")).toBe("image");
    expect(t("mediaTool.sent", { kind: "image", name: "shot.png", mode: "passive" })).toBe(
      "Sent image shot.png to QQ via passive reply.",
    );
    configureI18n("zh-cn");
    expect(t("mediaTool.kindImage")).toBe("图片");
    expect(t("mediaTool.sent", { kind: "图片", name: "shot.png", mode: "被动" })).toBe(
      "已通过被动回复将图片 shot.png 发送到 QQ。",
    );
  });

  it("validates language values", () => {
    expect(isLanguage("zh-cn")).toBe(true);
    expect(isLanguage("en-us")).toBe(true);
    expect(isLanguage("fr-fr")).toBe(false);
  });

  it("localizes reply type labels and hints", () => {
    configureI18n("en-us");
    expect(t("status.replyType")).toBe("Reply type");
    expect(t("settings.replyType")).toContain("replyType");
    expect(t("commands.last.empty")).toContain("still running");

    configureI18n("zh-cn");
    expect(t("status.replyType")).toBe("回复模式");
    expect(t("settings.replyType")).toContain("replyType");
    expect(t("commands.last.empty")).toContain("仍在执行中");
  });

  it("keeps known log messages English regardless of UI language", () => {
    configureI18n("zh-cn");
    expect(localizeLogMessage("starting bot")).toEqual({
      msg: "starting bot",
      msgKey: "log.sessionStartingBot",
    });
    expect(localizeLogMessage("unknown SDK message")).toEqual({ msg: "unknown SDK message" });

    configureI18n("en-us");
    expect(localizeLogMessage("starting bot")).toEqual({
      msg: "starting bot",
      msgKey: "log.sessionStartingBot",
    });
  });
});
