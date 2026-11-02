import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeLogLevel, type LogLevel } from "./logger";

export interface PiQQSettings {
  thinkingRelay?: boolean;
  deliverAs?: "steer" | "followUp";
  imageMaxSize?: number;
  fileMaxSize?: number;
  logLevel?: LogLevel;
  debug?: boolean;
}

export type PiQQConfig = PiQQSettings;

export interface Credentials {
  appId: string;
  appSecret: string;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-qq.json");

export function readConfig(): { config: PiQQConfig; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return { config: {} };
  }
  try {
    return { config: JSON.parse(raw) as PiQQConfig };
  } catch (e) {
    return { config: {}, error: `Failed to parse config file (${CONFIG_PATH}): ${(e as Error).message}` };
  }
}

export type ResolvedSettings = Required<Omit<PiQQSettings, "debug">>;

export function getSettings(config: PiQQConfig): ResolvedSettings {
  const logLevel = normalizeLogLevel(config.logLevel ?? (config.debug ? "debug" : undefined));
  return {
    thinkingRelay: config.thinkingRelay ?? true,
    deliverAs: config.deliverAs ?? "steer",
    imageMaxSize: config.imageMaxSize ?? 10 * 1024 * 1024,
    fileMaxSize: config.fileMaxSize ?? 50 * 1024 * 1024,
    logLevel,
  };
}
