import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeLogLevel, type LogLevel } from "./file-logger";
import { DEFAULT_LANGUAGE, getLanguage, isLanguage, translate, type Language } from "./i18n";
import { DEFAULT_REPLY_TYPE, isReplyType, type ReplyType } from "./reply-type";

export interface PiQQSettings {
  deliverAs?: "steer" | "followUp";
  replyType?: ReplyType;
  fileMaxSize?: number;
  logLevel?: LogLevel;
  language?: Language;
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

export function parseConfig(raw: unknown): ReadConfigResult {
  if (!isRecord(raw)) {
    return {
      config: {},
      error: translate(getLanguage(), "settings.invalidRoot", { path: CONFIG_PATH }),
    };
  }

  const language = isLanguage(raw.language) ? raw.language : getLanguage();
  const config: PiQQSettings = {};
  const errors: string[] = [];

  if (raw.language !== undefined) {
    if (isLanguage(raw.language)) config.language = raw.language;
    else errors.push(translate(language, "settings.language"));
  }
  if (raw.deliverAs !== undefined) {
    if (raw.deliverAs === "steer" || raw.deliverAs === "followUp") config.deliverAs = raw.deliverAs;
    else errors.push(translate(language, "settings.deliverAs"));
  }
  if (raw.replyType !== undefined) {
    if (isReplyType(raw.replyType)) config.replyType = raw.replyType;
    else errors.push(translate(language, "settings.replyType"));
  }
  if (raw.fileMaxSize !== undefined) {
    if (isPositiveSize(raw.fileMaxSize)) config.fileMaxSize = raw.fileMaxSize;
    else errors.push(translate(language, "settings.fileMaxSize"));
  }
  if (raw.logLevel !== undefined) {
    if (isLogLevel(raw.logLevel)) config.logLevel = raw.logLevel;
    else errors.push(translate(language, "settings.logLevel"));
  }
  if (raw.debug !== undefined) {
    if (typeof raw.debug === "boolean") config.debug = raw.debug;
    else errors.push(translate(language, "settings.debug"));
  }

  return errors.length > 0
    ? {
        config,
        error: translate(language, "settings.invalidFields", {
          path: CONFIG_PATH,
          errors: errors.join("; "),
        }),
      }
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
    return {
      config: {},
      error: translate(getLanguage(), "settings.parseFailed", {
        path: CONFIG_PATH,
        message: (e as Error).message,
      }),
    };
  }
}

export type ResolvedSettings = Required<Omit<PiQQSettings, "debug">>;

export function getSettings(config: PiQQSettings): ResolvedSettings {
  const logLevel = normalizeLogLevel(config.logLevel ?? (config.debug ? "debug" : undefined));
  return {
    deliverAs: config.deliverAs ?? "steer",
    replyType: config.replyType ?? DEFAULT_REPLY_TYPE,
    fileMaxSize: config.fileMaxSize ?? 50 * 1024 * 1024,
    logLevel,
    language: config.language ?? DEFAULT_LANGUAGE,
  };
}
