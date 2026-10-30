import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Structured logger for pi-qq.
 *
 * One JSON record per line, one file per local day:
 *   <cwd>/.pi/pi-qq/logs/pi-qq-YYYY-MM-DD.log
 *
 * The default level is silent. Logging is best-effort and must never break QQ
 * message handling. Tests can override the directory via PI_QQ_LOG_DIR.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "silent";

let activeLevel: LogLevel = DEFAULT_LOG_LEVEL;
let activeDir: string | undefined;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEVEL_WEIGHT, value);
}

export function normalizeLogLevel(value: unknown): LogLevel {
  return isLogLevel(value) ? value : DEFAULT_LOG_LEVEL;
}

/** Whether an event at `level` passes the configured threshold. */
export function isLevelEnabled(configured: LogLevel, level: Exclude<LogLevel, "silent">): boolean {
  return configured !== "silent" && LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configured];
}

/** Set the active threshold and optional directory. */
export function configureLogger(level: LogLevel, dir?: string): void {
  activeLevel = normalizeLogLevel(level);
  activeDir = dir;
}

export function getLogLevel(): LogLevel {
  return activeLevel;
}

export function resolveLogDir(): string {
  return process.env.PI_QQ_LOG_DIR ?? activeDir ?? join(process.cwd(), ".pi", "pi-qq", "logs");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar date used in the log filename. */
export function dateStamp(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function logFileName(now = new Date()): string {
  return `pi-qq-${dateStamp(now)}.log`;
}

export function getLogFilePath(now = new Date()): string {
  return join(resolveLogDir(), logFileName(now));
}

function normalizeData(data: unknown): LogFields | undefined {
  if (data === undefined) return undefined;
  if (data instanceof Error) return { err: data };
  if (data !== null && typeof data === "object" && !Array.isArray(data)) return data as LogFields;
  return { data };
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function writeRecord(level: Exclude<LogLevel, "silent">, scope: string, message: string, data?: unknown): void {
  if (!isLevelEnabled(activeLevel, level)) return;

  const record: LogFields = {
    time: new Date().toISOString(),
    level,
    scope,
    msg: message,
  };
  const fields = normalizeData(data);
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      // Protect the record envelope from accidental overrides.
      if (!(key in record)) record[key] = value;
    }
  }

  let line: string;
  try {
    line = JSON.stringify(record, (_key, value) => {
      if (typeof value === "bigint") return `${value}n`;
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    });
  } catch (err) {
    line = JSON.stringify({
      time: record.time,
      level,
      scope,
      msg: message,
      serializationError: stringifyError(err),
    });
  }

  try {
    const dir = resolveLogDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, logFileName()), `${line}\n`, "utf8");
  } catch {
    // Logging is diagnostic only; never break message handling.
  }
}

export const log = {
  get level(): LogLevel {
    return activeLevel;
  },
  debug(scope: string, message: string, data?: unknown): void {
    writeRecord("debug", scope, message, data);
  },
  info(scope: string, message: string, data?: unknown): void {
    writeRecord("info", scope, message, data);
  },
  warn(scope: string, message: string, data?: unknown): void {
    writeRecord("warn", scope, message, data);
  },
  error(scope: string, message: string, data?: unknown): void {
    writeRecord("error", scope, message, data);
  },
};

/** Adapter for the QQ SDK's Logger interface: (message, meta?) -> record. */
export const sdkLogger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    log.debug("qqbot", message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    log.info("qqbot", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    log.warn("qqbot", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    log.error("qqbot", message, meta);
  },
};

/** Short string form for noisy tool payloads. */
export function previewForLog(value: unknown, maxChars = 2000): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = `${value.name}: ${value.message}`;
  } else {
    try {
      const stringified = JSON.stringify(value);
      text = typeof stringified === "string" ? stringified : String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…(${text.length} chars)`;
}
