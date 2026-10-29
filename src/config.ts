import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ~/.pi/agent/pi-qq.json contains non-secret settings only.
 *
 * QQ credentials are intentionally never written to disk: QR login keeps them in
 * process memory, so restarting pi requires scanning a new QR code.
 */

/** Runtime settings (features-v1.md §4). */
export interface PiQQSettings {
  /** F4: stream assistant replies */
  streamAssistant?: boolean;
  /** F4: bot has QQ markdown permission; pass Markdown through when true */
  markdownSupport?: boolean;
  /** F2: how a busy agent handles new messages */
  deliverAs?: "steer" | "followUp";
  /** F3: QQ image download limit (bytes) */
  imageMaxSize?: number;
  /** F3: QQ file download limit (bytes), default 50MB */
  fileMaxSize?: number;
  /** F7: heartbeat interval in minutes, 0 disables */
  heartbeatMinutes?: number;
  /** F7: per-run message heartbeat limit */
  heartbeatMaxMessages?: number;
  /** F7: stream summary frame interval (ms, minimum 300) */
  streamFlushMs?: number;
  /** Diagnostic mode: SDK logs + stream retry/timeout logs */
  debug?: boolean;
  /** F7: append-mode stream relay switch */
  streamRelay?: boolean;
}

/** Settings file schema (legacy credential keys are ignored). */
export type PiQQConfig = PiQQSettings;

/** QR login result; kept in memory only. */
export interface Credentials {
  appId: string;
  appSecret: string;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-qq.json");

/** Read settings; missing file yields empty settings, malformed JSON returns an error. */
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

export interface ResolvedSettings extends Required<PiQQSettings> {}

/** Settings with defaults applied (features-v1.md §4). */
export function getSettings(config: PiQQConfig): ResolvedSettings {
  return {
    streamAssistant: config.streamAssistant ?? true,
    markdownSupport: config.markdownSupport ?? false,
    deliverAs: config.deliverAs ?? "steer",
    imageMaxSize: config.imageMaxSize ?? 10 * 1024 * 1024,
    fileMaxSize: config.fileMaxSize ?? 50 * 1024 * 1024,
    heartbeatMinutes: config.heartbeatMinutes ?? 10,
    heartbeatMaxMessages: config.heartbeatMaxMessages ?? 3,
    streamFlushMs: config.streamFlushMs ?? 10_000,
    debug: config.debug ?? false,
    streamRelay: config.streamRelay ?? true,
  };
}
