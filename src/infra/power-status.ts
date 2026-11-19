import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./file-logger";

export interface PowerStatus {
  percent?: number;
  state: "charging" | "discharging" | "ac";
}

const CACHE_MS = 30_000;
const MACOS_TIMEOUT_MS = 500;
// PowerShell cold start plus the CIM query takes about 0.7 s on a warm cache
// and longer on a cold one; 500 ms killed the process before it could answer.
const WINDOWS_TIMEOUT_MS = 3000;
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

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function readPowerStatus(): Promise<PowerStatus | undefined> {
  if (process.platform === "linux") return readLinuxBattery();
  if (process.platform === "darwin") {
    return parsePmsetOutput(await run("pmset", ["-g", "batt"], MACOS_TIMEOUT_MS));
  }
  if (process.platform === "win32") {
    const output = await run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress",
      ],
      WINDOWS_TIMEOUT_MS,
    );
    return parseWindowsBattery(output);
  }
  return undefined;
}

export function resetPowerStatusCache(): void {
  cache = undefined;
}

export async function getPowerStatus(
  now = Date.now(),
  read: () => Promise<PowerStatus | undefined> = readPowerStatus,
): Promise<PowerStatus | undefined> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value: PowerStatus | undefined;
  try {
    value = await read();
  } catch (err) {
    const e = err as { code?: string | number; killed?: boolean; signal?: string };
    log.debug("power", "power status read failed", {
      platform: process.platform,
      code: e?.code ?? null,
      killed: e?.killed ?? null,
      signal: e?.signal ?? null,
    });
  }
  cache = { at: now, value };
  return value;
}
