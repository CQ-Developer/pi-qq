import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureLogger,
  dateStamp,
  getLogFilePath,
  isLevelEnabled,
  log,
  logFileName,
  normalizeLogLevel,
  previewForLog,
} from "../src/logger";

afterEach(() => {
  configureLogger("silent");
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
});

describe("log file name", () => {
  it("uses the local calendar date", () => {
    const date = new Date(2026, 9, 30, 12, 0, 0);
    expect(dateStamp(date)).toBe("2026-10-30");
    expect(logFileName(date)).toBe("pi-qq-2026-10-30.log");
  });
});

describe("previewForLog", () => {
  it("handles strings, undefined, and errors", () => {
    expect(previewForLog("hello")).toBe("hello");
    expect(previewForLog(undefined)).toBe("undefined");
    expect(previewForLog({ a: 1 })).toBe('{"a":1}');
    expect(previewForLog(new Error("boom"))).toContain("boom");
  });

  it("truncates long values", () => {
    const value = "x".repeat(100);
    expect(previewForLog(value, 10)).toBe("xxxxxxxxxx…(100 chars)");
  });
});

describe("file output", () => {
  it("writes JSONL records and respects silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-qq-log-"));
    try {
      configureLogger("debug", dir);
      log.info("test", "hello", { answer: 42, err: new Error("boom") });

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
      expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
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
      const record = JSON.parse((await readFile(getLogFilePath(), "utf8")).trim());
      expect(record.msg).toBe("env override");
    } finally {
      if (previous === undefined) delete process.env.PI_QQ_LOG_DIR;
      else process.env.PI_QQ_LOG_DIR = previous;
      await rm(envDir, { recursive: true, force: true });
      await rm(configuredDir, { recursive: true, force: true });
    }
  });
});
