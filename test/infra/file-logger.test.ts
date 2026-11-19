import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureLogger,
  dateStamp,
  flushLogs,
  getLogFilePath,
  isLevelEnabled,
  isLogEnabled,
  log,
  logFileName,
  logValueLength,
  normalizeLogLevel,
  redactLogText,
  sdkLogger,
  setLogGate,
} from "../../src/infra/file-logger";

afterEach(async () => {
  configureLogger("silent");
  setLogGate(undefined);
  await flushLogs();
});

describe("log level", () => {
  it("normalizes valid and invalid levels", () => {
    expect(normalizeLogLevel("debug")).toBe("debug");
    expect(normalizeLogLevel("info")).toBe("info");
    expect(normalizeLogLevel("warn")).toBe("warn");
    expect(normalizeLogLevel("error")).toBe("error");
    expect(normalizeLogLevel("silent")).toBe("silent");
    expect(normalizeLogLevel("verbose")).toBe("silent");
    expect(normalizeLogLevel(undefined)).toBe("silent");
  });

  it("filters by threshold", () => {
    expect(isLevelEnabled("debug", "debug")).toBe(true);
    expect(isLevelEnabled("debug", "info")).toBe(true);
    expect(isLevelEnabled("info", "debug")).toBe(false);
    expect(isLevelEnabled("warn", "info")).toBe(false);
    expect(isLevelEnabled("warn", "error")).toBe(true);
    expect(isLevelEnabled("silent", "error")).toBe(false);
  });

  it("exposes the active threshold for lazy payloads", () => {
    configureLogger("debug");
    expect(isLogEnabled("debug")).toBe(true);
    configureLogger("info");
    expect(isLogEnabled("debug")).toBe(false);
    configureLogger("silent");
    expect(isLogEnabled("error")).toBe(false);
  });
});

describe("log file name", () => {
  it("uses the local calendar date", () => {
    const date = new Date(2026, 9, 30, 12, 0, 0);
    expect(dateStamp(date)).toBe("2026-10-30");
    expect(logFileName(date)).toBe("pi-qq-2026-10-30.log");
  });
});

describe("logValueLength", () => {
  it("returns content length without returning content", () => {
    expect(logValueLength("hello")).toBe(5);
    expect(logValueLength(undefined)).toBe(0);
    expect(logValueLength({ a: 1 })).toBe(7);
  });
});

describe("redaction", () => {
  it("redacts common credential shapes", () => {
    const text = [
      "mysql -uroot -ppcagent-local pc_agent",
      "Authorization: Bearer abc.def",
      "Cookie: session=secret",
      '{"password":"hunter2","token":"tok","session":"sess","sessionBubbles":4}',
      "pcagent:next:web:session:0123456789abcdef",
    ].join("\n");
    const redacted = redactLogText(text);

    expect(redacted).not.toContain("ppcagent-local");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("0123456789abcdef");
    expect(redacted).toContain("sessionBubbles");
  });
});

describe("file output", () => {
  it("writes JSONL records and respects silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-"));
    try {
      configureLogger("debug", dir);
      log.info("test", "hello", { answer: 42, err: new Error("boom") });
      await flushLogs();

      const path = getLogFilePath();
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);

      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(record.level).toBe("info");
      expect(record.scope).toBe("test");
      expect(record.msg).toBe("hello");
      expect(record.answer).toBe(42);
      expect(record.err).toMatchObject({ name: "Error", message: "boom" });

      configureLogger("silent", dir);
      log.error("test", "hidden");
      await flushLogs();
      expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes known log messages in English and keeps msgKey", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-i18n-"));
    try {
      configureLogger("debug", dir);
      log.info("session", "starting bot", { appId: "a" });
      await flushLogs();
      const lines = (await readFile(getLogFilePath(), "utf8")).trim().split("\n");
      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(record.msgKey).toBe("log.sessionStartingBot");
      expect(record.msg).toBe("starting bot");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when the log directory is not writable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-"));
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "x");
    try {
      configureLogger("debug", blocked);
      expect(() => log.info("test", "hello")).not.toThrow();
      await expect(flushLogs()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets PI_QQ_LOG_DIR override the configured directory", async () => {
    const envDir = await mkdtemp(join(tmpdir(), "pi-qq-log-env-"));
    const configuredDir = await mkdtemp(join(tmpdir(), "pi-qq-log-cfg-"));
    const previous = process.env.PI_QQ_LOG_DIR;
    try {
      process.env.PI_QQ_LOG_DIR = envDir;
      configureLogger("debug", configuredDir);
      log.info("test", "env override");
      await flushLogs();
      const record = JSON.parse((await readFile(getLogFilePath(), "utf8")).trim());
      expect(record.msg).toBe("env override");
    } finally {
      if (previous === undefined) delete process.env.PI_QQ_LOG_DIR;
      else process.env.PI_QQ_LOG_DIR = previous;
      await rm(envDir, { recursive: true, force: true });
      await rm(configuredDir, { recursive: true, force: true });
    }
  });

  it("skips records while the log gate is closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-gate-"));
    try {
      configureLogger("debug", dir);
      setLogGate(() => false);
      log.info("test", "hidden");
      await flushLogs();
      await expect(readFile(getLogFilePath(), "utf8")).rejects.toThrow();

      setLogGate(() => true);
      log.info("test", "visible");
      await flushLogs();
      const lines = (await readFile(getLogFilePath(), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]!) as Record<string, unknown>).msg).toBe("visible");
    } finally {
      setLogGate(undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes the log scope to the gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-gate-scope-"));
    try {
      configureLogger("debug", dir);
      setLogGate((scope) => scope === "login");
      log.info("login", "visible login");
      log.info("stream", "hidden stream");
      await flushLogs();
      const lines = (await readFile(getLogFilePath(), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]!) as Record<string, unknown>).msg).toBe("visible login");
    } finally {
      setLogGate(undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("summarizes SDK bodies instead of logging their content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-sdk-body-"));
    try {
      configureLogger("debug", dir);
      sdkLogger.debug('[qqbot:api] >>> Body: {"content":"secret"}');
      await flushLogs();
      const record = JSON.parse((await readFile(getLogFilePath(), "utf8")).trim()) as Record<string, unknown>;
      expect(String(record.msg)).toContain("Body: <");
      expect(String(record.msg)).not.toContain("secret");
    } finally {
      configureLogger("silent");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("redacts secret fields before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-redact-"));
    try {
      configureLogger("debug", dir);
      log.info("test", "payload", {
        password: "hunter2",
        token: "tok-123",
        session: "sess-456",
        sessionBubbles: 4,
        command: "mysql -uroot -psecret",
      });
      await flushLogs();
      const record = JSON.parse((await readFile(getLogFilePath(), "utf8")).trim()) as Record<string, unknown>;
      expect(record.password).toBe("<redacted>");
      expect(record.token).toBe("<redacted>");
      expect(record.session).toBe("<redacted>");
      expect(record.sessionBubbles).toBe(4);
      expect(String(record.command)).not.toContain("-psecret");
    } finally {
      configureLogger("silent");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shortens message identifiers before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-ids-"));
    try {
      configureLogger("debug", dir);
      log.info("test", "ids", {
        messageId: "ROBOT1.0_UMkNSaLLKokdOorNg7BODxTq",
        msgId: "ROBOT1.0_UMkNSaLLKokdOorNg7BODxTq",
        streamMsgId: "0ea26a0f-8e82-44c6-97f6-7598f44d8190",
        senderId: "openid-12345678",
      });
      await flushLogs();
      const record = JSON.parse((await readFile(getLogFilePath(), "utf8")).trim()) as Record<string, unknown>;
      expect(record.messageId).toBe("UMkNSaLL");
      expect(record.msgId).toBe("UMkNSaLL");
      expect(record.streamMsgId).toBe("0ea2…8190");
      expect(record.senderId).toBe("openid-12345678");
    } finally {
      configureLogger("silent");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a throwing gate as closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-gate-"));
    try {
      configureLogger("debug", dir);
      setLogGate(() => {
        throw new Error("gate failed");
      });
      expect(() => log.info("test", "hidden")).not.toThrow();
      await flushLogs();
      await expect(readFile(getLogFilePath(), "utf8")).rejects.toThrow();
    } finally {
      setLogGate(undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not write debug logs when level is silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-"));
    try {
      configureLogger("silent", dir);
      log.debug("test", "hidden");
      await flushLogs();
      await expect(readFile(getLogFilePath(), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
