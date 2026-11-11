import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface PowerStatus {
  percent?: number;
  state: "charging" | "discharging" | "ac";
}

const CACHE_MS = 30_000;
let cache: { at: number; value: PowerStatus | undefined } | undefined;

function clampPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function parsePmsetOutput(output: string): PowerStatus | undefined {
  if (!/InternalBattery|Battery/i.test(output)) return undefined;
  const percentMatch = output.match(/(\d+)%/);
  const percent = percentMatch ? clampPercent(Number(percentMatch[1])) : undefined;
  const state = /discharging/i.test(output) ? "discharging" : /charging/i.test(output) ? "charging" : "ac";
  return { percent, state };
}

interface WindowsBattery {
  EstimatedChargeRemaining?: number | string;
  BatteryStatus?: number | string;
}

export function parseWindowsBattery(output: string): PowerStatus | undefined {
  let parsed: WindowsBattery | WindowsBattery[] | null;
  try {
    parsed = JSON.parse(output) as WindowsBattery | WindowsBattery[] | null;
  } catch {
    return undefined;
  }
  const battery = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!battery) return undefined;

  const percent = clampPercent(Number(battery.EstimatedChargeRemaining));
  const status = Number(battery.BatteryStatus);
  const state =
    status === 1 || status === 4 || status === 5 ? "discharging" : status >= 6 && status <= 9 ? "charging" : "ac";
  return { percent, state };
}

export function readLinuxBattery(root = "/sys/class/power_supply"): PowerStatus | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root).filter((name) => name.startsWith("BAT"));
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;

  for (const entry of entries) {
    try {
      const dir = join(root, entry);
      const rawPercent = readFileSync(join(dir, "capacity"), "utf8").trim();
      const percent = clampPercent(Number(rawPercent));
      const rawStatus = readFileSync(join(dir, "status"), "utf8").trim().toLowerCase();
      const state = rawStatus === "charging" ? "charging" : rawStatus === "discharging" ? "discharging" : "ac";
      return { percent, state };
    } catch {}
  }
  return undefined;
}

function readPowerStatus(): PowerStatus | undefined {
  try {
    if (process.platform === "linux") return readLinuxBattery();
    if (process.platform === "darwin") {
      const output = execFileSync("pmset", ["-g", "batt"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parsePmsetOutput(output);
    }
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] },
      );
      return parseWindowsBattery(output);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function getPowerStatus(now = Date.now()): PowerStatus | undefined {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const value = readPowerStatus();
  cache = { at: now, value };
  return value;
}
