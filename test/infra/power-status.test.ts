import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePmsetOutput, parseWindowsBattery, readLinuxBattery } from "../../src/infra/power-status";

describe("power status parsers", () => {
  it("parses macOS pmset battery states", () => {
    expect(
      parsePmsetOutput("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1) 84%; discharging; 4:12 remaining"),
    ).toEqual({ percent: 84, state: "discharging" });
    expect(parsePmsetOutput("-InternalBattery-0 (id=1) 42%; charging; 1:00 remaining")).toEqual({
      percent: 42,
      state: "charging",
    });
    expect(parsePmsetOutput("-InternalBattery-0 (id=1) 100%; charged; AC attached")).toEqual({
      percent: 100,
      state: "ac",
    });
    expect(parsePmsetOutput("No batteries")).toBeUndefined();
  });

  it("parses Windows battery JSON", () => {
    expect(parseWindowsBattery('{"EstimatedChargeRemaining":77,"BatteryStatus":1}')).toEqual({
      percent: 77,
      state: "discharging",
    });
    expect(parseWindowsBattery('{"EstimatedChargeRemaining":60,"BatteryStatus":6}')).toEqual({
      percent: 60,
      state: "charging",
    });
    expect(parseWindowsBattery('{"EstimatedChargeRemaining":100,"BatteryStatus":2}')).toEqual({
      percent: 100,
      state: "ac",
    });
    expect(parseWindowsBattery("not json")).toBeUndefined();
  });

  it("reads Linux power_supply", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-qq-power-"));
    try {
      const bat = join(root, "BAT0");
      await mkdir(bat);
      await writeFile(join(bat, "capacity"), "55\n");
      await writeFile(join(bat, "status"), "Charging\n");
      expect(readLinuxBattery(root)).toEqual({ percent: 55, state: "charging" });

      await writeFile(join(bat, "status"), "Full\n");
      expect(readLinuxBattery(root)).toEqual({ percent: 55, state: "ac" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when no battery exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-qq-power-"));
    try {
      expect(readLinuxBattery(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
