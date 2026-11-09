import { beforeEach, describe, expect, it } from "vitest";
import { configureI18n } from "../../src/infra/i18n";
import { formatStatusReport } from "../../src/qq/status-report";

describe("formatStatusReport", () => {
  beforeEach(() => configureI18n("en-us"));

  it("renders login, connection, agent, context, QQ user and battery", () => {
    expect(
      formatStatusReport({
        login: { appId: "abcd1234", openid: "openid-12345678" },
        connection: { state: "connected" },
        agent: { running: true, qq: true },
        model: { name: "test-model" },
        usage: { tokens: 12345, contextWindow: 200000, percent: 6.2 },
        power: { percent: 85, state: "discharging" },
      }),
    ).toEqual([
      "🖥️ pi-qq status",
      "🔐 Login: QR login (AppID abcd****)",
      "🌐 Connection: connected",
      "🏃 Agent: running (QQ)",
      "🧠 Model: test-model",
      "📊 Context: 12.3k/200k (6.2%)",
      "👤 QQ user: openid-1…",
      "🔋 Battery: 85% (discharging)",
      "⚙️ Settings: ~/.pi/agent/pi-qq.json",
    ]);
  });

  it("renders Chinese text and hides battery when unavailable", () => {
    configureI18n("zh-cn");
    const lines = formatStatusReport({
      login: { appId: "abcd1234", openid: "openid-12345678" },
      connection: { state: "connected" },
      agent: { running: false, qq: false },
      model: { name: "test-model" },
      usage: { tokens: 12345, contextWindow: 200000, percent: 6.2 },
    });
    expect(lines).toEqual([
      "🖥️ pi-qq 状态",
      "🔐 登录：扫码登录（AppID abcd****）",
      "🌐 连接：已连接",
      "✅ 执行：已完成",
      "🧠 模型：test-model",
      "📊 上下文：12.3k/200k（6.2%）",
      "👤 QQ 用户：openid-1…",
      "⚙️ 设置：~/.pi/agent/pi-qq.json",
    ]);
    expect(lines.some((line) => line.includes("Battery") || line.includes("电量"))).toBe(false);
  });

  it("shows local running and connection details", () => {
    const lines = formatStatusReport({
      connection: { state: "blocked", detail: "banned" },
      agent: { running: true, qq: false },
    });
    expect(lines).toContain("🚫 Connection: blocked (banned)");
    expect(lines).toContain("🏃 Agent: running (local)");
  });

  it("hides login and QQ user when not logged in", () => {
    const lines = formatStatusReport({
      connection: { state: "stopped" },
      agent: { running: false, qq: false },
    });
    expect(lines).toContain("⚪ Login: not logged in");
    expect(lines).toContain("👤 QQ user: none");
  });

  it("renders AC battery without percentage", () => {
    expect(
      formatStatusReport({
        connection: { state: "starting" },
        agent: { running: false, qq: false },
        power: { state: "ac" },
      }),
    ).toContain("⚡ Battery: AC");
  });

  it("renders the reply type when provided", () => {
    expect(
      formatStatusReport({
        connection: { state: "connected" },
        agent: { running: false, qq: false },
        replyType: "simple",
      }),
    ).toContain("💬 Reply type: simple");

    configureI18n("zh-cn");
    expect(
      formatStatusReport({
        connection: { state: "connected" },
        agent: { running: false, qq: false },
        replyType: "last",
      }),
    ).toContain("💬 回复模式：last");
  });

  it("omits the reply type when unknown", () => {
    const lines = formatStatusReport({
      connection: { state: "connected" },
      agent: { running: false, qq: false },
    });
    expect(lines.some((line) => line.includes("Reply type") || line.includes("回复模式"))).toBe(false);
  });
});
