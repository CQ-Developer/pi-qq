import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeLogLevel, type LogLevel } from "./file-logger";

export interface PiQQSettings {
  thinkingRelay?: boolean;
  deliverAs?: "steer" | "followUp";
  imageMaxSize?: number;
  fileMaxSize?: number;
  logLevel?: LogLevel;
  debug?: boolean;
}

export interface Credentials {
  appId: string;
  appSecret: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-qq.json");

interface ReadConfigResult {
  config: PiQQSettings;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "silent" || value === "error" || value === "warn" || value === "info" || value === "debug";
}

function isPositiveSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Validate the on-disk shape before it reaches business code. Invalid fields
 * are dropped individually so one typo does not discard the whole config.
 */
export function parseConfig(raw: unknown): ReadConfigResult {
  if (!isRecord(raw)) {
    return {
      config: {},
      error: `Invalid config file (${CONFIG_PATH}): expected a JSON object; using defaults.`,
    };
  }

  const config: PiQQSettings = {};
  const errors: string[] = [];

  if (raw.thinkingRelay !== undefined) {
    if (typeof raw.thinkingRelay === "boolean") config.thinkingRelay = raw.thinkingRelay;
    else errors.push("thinkingRelay must be a boolean");
  }
  if (raw.deliverAs !== undefined) {
    if (raw.deliverAs === "steer" || raw.deliverAs === "followUp") config.deliverAs = raw.deliverAs;
    else errors.push('deliverAs must be "steer" or "followUp"');
  }
  if (raw.imageMaxSize !== undefined) {
    if (isPositiveSize(raw.imageMaxSize)) config.imageMaxSize = raw.imageMaxSize;
    else errors.push("imageMaxSize must be a positive finite number");
  }
  if (raw.fileMaxSize !== undefined) {
    if (isPositiveSize(raw.fileMaxSize)) config.fileMaxSize = raw.fileMaxSize;
    else errors.push("fileMaxSize must be a positive finite number");
  }
  if (raw.logLevel !== undefined) {
    if (isLogLevel(raw.logLevel)) config.logLevel = raw.logLevel;
    else errors.push('logLevel must be "silent", "error", "warn", "info", or "debug"');
  }
  if (raw.debug !== undefined) {
    if (typeof raw.debug === "boolean") config.debug = raw.debug;
    else errors.push("debug must be a boolean");
  }

  return errors.length > 0
    ? { config, error: `Invalid config file (${CONFIG_PATH}): ${errors.join("; ")}; invalid values were ignored.` }
    : { config };
}

export function readConfig(): ReadConfigResult {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return { config: {} };
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch (e) {
    return { config: {}, error: `Failed to parse config file (${CONFIG_PATH}): ${(e as Error).message}` };
  }
}

export type ResolvedSettings = Required<Omit<PiQQSettings, "debug">>;

export function getSettings(config: PiQQSettings): ResolvedSettings {
  const logLevel = normalizeLogLevel(config.logLevel ?? (config.debug ? "debug" : undefined));
  return {
    thinkingRelay: config.thinkingRelay ?? true,
    deliverAs: config.deliverAs ?? "steer",
    imageMaxSize: config.imageMaxSize ?? 10 * 1024 * 1024,
    fileMaxSize: config.fileMaxSize ?? 50 * 1024 * 1024,
    logLevel,
  };
}
