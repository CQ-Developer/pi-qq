import type { PowerStatus } from "../infra/power-status";
import { formatTokenCount } from "../infra/display-format";
import type { ReplyType } from "../infra/reply-type";
import { t, type TranslationKey } from "../infra/i18n";
import type { BotState } from "./qq-bot";

export interface StatusReportInput {
  login?: { appId: string; openid: string };
  connection: { state: BotState; detail?: string };
  agent: { running: boolean; qq: boolean };
  model?: { name: string };
  usage?: { tokens: number | null; contextWindow: number | null; percent?: number | null };
  power?: PowerStatus;
  replyType?: ReplyType;
}

const STATE_ICONS: Record<BotState, string> = {
  connected: "🌐",
  reconnecting: "🔄",
  stopped: "⛔",
  starting: "⏳",
  blocked: "🚫",
};

const STATE_LABELS: Record<BotState, TranslationKey> = {
  connected: "status.state.connected",
  reconnecting: "status.state.reconnecting",
  stopped: "status.state.stopped",
  starting: "status.state.starting",
  blocked: "status.state.blocked",
};

function maskAppId(appId: string): string {
  return `${appId.slice(0, 4)}****`;
}

function maskOpenid(openid: string): string {
  return `${openid.slice(0, 8)}…`;
}

function label(
  key:
    | "status.agent"
    | "status.context"
    | "status.model"
    | "status.login"
    | "status.connection"
    | "status.qqUser"
    | "status.battery"
    | "status.replyType"
    | "status.settings",
  value: string,
): string {
  return `${t(key)}${t("status.separator")}${value}`;
}

function agentLine(agent: StatusReportInput["agent"]): string {
  if (!agent.running) return `✅ ${label("status.agent", t("status.agent.completed"))}`;
  const value = agent.qq ? t("status.agent.runningQQ") : t("status.agent.runningLocal");
  return `🏃 ${label("status.agent", value)}`;
}

function contextLine(usage: StatusReportInput["usage"]): string {
  if (!usage) return `📊 ${label("status.context", t("status.unknown"))}`;
  const percent = usage.percent?.toFixed(1) ?? "?";
  const tokens = usage.tokens === null ? t("status.unknown") : formatTokenCount(usage.tokens);
  const window = usage.contextWindow === null ? t("status.unknown") : formatTokenCount(usage.contextWindow);
  return `📊 ${label("status.context", t("status.contextValue", { tokens, window, percent }))}`;
}

function batteryLine(power: PowerStatus | undefined): string | undefined {
  if (!power) return undefined;
  const icon = power.state === "charging" ? "🔌" : power.state === "discharging" ? "🔋" : "⚡";
  const value =
    power.percent === undefined
      ? t(
          power.state === "charging"
            ? "status.batteryChargingNoPercent"
            : power.state === "discharging"
              ? "status.batteryDischargingNoPercent"
              : "status.batteryAcNoPercent",
        )
      : t(
          power.state === "charging"
            ? "status.batteryCharging"
            : power.state === "discharging"
              ? "status.batteryDischarging"
              : "status.batteryAc",
          { percent: power.percent },
        );
  return `${icon} ${label("status.battery", value)}`;
}

export function formatStatusReport(input: StatusReportInput): string[] {
  const stateLabel = t(STATE_LABELS[input.connection.state]);
  const detail = input.connection.detail ? t("status.detail", { detail: input.connection.detail }) : "";
  const loginLine = input.login
    ? `🔐 ${label("status.login", t("status.loginValue", { appId: maskAppId(input.login.appId) }))}`
    : `⚪ ${label("status.login", t("status.notLoggedIn"))}`;

  const lines = [
    `🖥️ ${t("status.title")}`,
    loginLine,
    `${STATE_ICONS[input.connection.state]} ${label("status.connection", `${stateLabel}${detail}`)}`,
    agentLine(input.agent),
    `🧠 ${label("status.model", input.model?.name ?? t("status.none"))}`,
    contextLine(input.usage),
    `👤 ${label("status.qqUser", input.login ? maskOpenid(input.login.openid) : t("status.none"))}`,
  ];

  const battery = batteryLine(input.power);
  if (battery) lines.push(battery);
  if (input.replyType) lines.push(`💬 ${label("status.replyType", input.replyType)}`);
  lines.push(`⚙️ ${label("status.settings", "~/.pi/agent/pi-qq.json")}`);
  return lines;
}
