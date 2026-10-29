import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * ~/.pi/agent/pi-qq.json 的类型与读写。
 *
 * 凭据键名以用户手写 schema（AppID/AppSecret）为准，读取时兼容小写；
 * 扩展写入（扫码成功后）统一归一化为大写键名，避免同一文件里出现两套键。
 */

/** 可调设置（features.md §4），与凭据共存于同一文件。 */
export interface PiQQSettings {
  /** F4：assistant 流式回传开关 */
  streamAssistant?: boolean;
  /** F4：机器人是否有 markdown 权限；true 时回传透传 Markdown */
  markdownSupport?: boolean;
  /** F5/F6：用量摘要（token+成本+上下文占比）开关 */
  usageRelay?: boolean;
  /** F2：agent 忙碌时新消息的处理方式 */
  deliverAs?: "steer" | "followUp";
  /** F6：上下文占比告警阈值（百分比） */
  contextWarnPercent?: number;
  /** F3：QQ 图片下载上限（字节） */
  imageMaxSize?: number;
  /** F7：节流心跳间隔（分钟），0 关闭 */
  heartbeatMinutes?: number;
  /** F7：每 run 消息心跳上限（流式心跳不受限） */
  heartbeatMaxMessages?: number;
  /** F7：流式汇总帧间隔（毫秒，最小 300，默认 10s）；帧内容为窗口内思考/工具计数/文本增量 */
  streamFlushMs?: number;
  /** 诊断模式：SDK 内部日志打到终端 + 文本帧也带时间戳（定位超时/限流用） */
  debug?: boolean;
  /** F7：流式载体开关。QQ stream_messages 仅支持 markdown 内容（无权限时帧被接受但不渲染），
   *  无 markdown 权限的机器人必须保持 false（实测：气泡停在 "..." 且结果被流接管丢失） */
  streamRelay?: boolean;
}

/** 完整配置文件结构：凭据 + 单人绑定 + 可调设置。 */
export interface PiQQConfig extends PiQQSettings {
  AppID?: string;
  AppSecret?: string;
  /** 兼容小写写法（仅读取） */
  appId?: string;
  appSecret?: string;
  /** F2：单人绑定的 openid 白名单 */
  allowedOpenid?: string;
}

export interface Credentials {
  appId: string;
  appSecret: string;
}

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-qq.json");

/** 读配置；文件不存在视为空配置，JSON 损坏时返回 error（调用方不得覆盖写入）。 */
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
    return { config: {}, error: `配置文件解析失败（${CONFIG_PATH}）：${(e as Error).message}` };
  }
}

/** 从配置提取机器人凭据（大写/小写键均可），不完整返回 null。 */
export function getCredentials(config: PiQQConfig): Credentials | null {
  const appId = config.AppID ?? config.appId;
  const appSecret = config.AppSecret ?? config.appSecret;
  if (appId && appSecret) return { appId, appSecret };
  return null;
}

function writeConfig(config: PiQQConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  // mode 只在新建文件时生效，已存在文件需显式 chmod 回 0600
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

/** 写入凭据（归一化为大写键名，清除兼容小写键）；userOpenid 提供时覆盖单人绑定。 */
export function saveCredentials(creds: Credentials, opts?: { userOpenid?: string }): void {
  const { config, error } = readConfig();
  if (error) throw new Error(`拒绝写入：${error}`);
  delete config.appId;
  delete config.appSecret;
  config.AppID = creds.appId;
  config.AppSecret = creds.appSecret;
  if (opts?.userOpenid) config.allowedOpenid = opts.userOpenid;
  writeConfig(config);
}

/** /qq-logout：清除凭据，保留 allowedOpenid 与其余设置（下次登录同一用户无需重配）。 */
export function clearCredentials(): void {
  const { config, error } = readConfig();
  if (error) return;
  delete config.AppID;
  delete config.AppSecret;
  delete config.appId;
  delete config.appSecret;
  writeConfig(config);
}

/** F2 的"首个私聊用户自动绑定"（M2 接线使用）。 */
export function setAllowedOpenid(openid: string): void {
  const { config, error } = readConfig();
  if (error) return;
  config.allowedOpenid = openid;
  writeConfig(config);
}

export interface ResolvedSettings extends Required<PiQQSettings> {}

/** 填充默认值后的设置视图（features.md §4 默认列）。 */
export function getSettings(config: PiQQConfig): ResolvedSettings {
  return {
    streamAssistant: config.streamAssistant ?? true,
    markdownSupport: config.markdownSupport ?? false,
    usageRelay: config.usageRelay ?? true,
    deliverAs: config.deliverAs ?? "steer",
    contextWarnPercent: config.contextWarnPercent ?? 80,
    imageMaxSize: config.imageMaxSize ?? 10 * 1024 * 1024,
    heartbeatMinutes: config.heartbeatMinutes ?? 10,
    heartbeatMaxMessages: config.heartbeatMaxMessages ?? 3,
    streamFlushMs: config.streamFlushMs ?? 10_000,
    debug: config.debug ?? false,
    // append 语义已实测可用（含节流与限流退避）；失败自动降级消息路径，默认开启
    streamRelay: config.streamRelay ?? true,
  };
}
