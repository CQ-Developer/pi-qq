import { describe, expect, it } from "vitest";
import { getSettings } from "../src/config";

describe("logLevel settings", () => {
  it("defaults to silent", () => {
    expect(getSettings({}).logLevel).toBe("silent");
    expect(getSettings({ debug: false }).logLevel).toBe("silent");
  });

  it("accepts an explicit level", () => {
    expect(getSettings({ logLevel: "info" }).logLevel).toBe("info");
    expect(getSettings({ logLevel: "debug" }).logLevel).toBe("debug");
  });

  it("migrates legacy debug=true", () => {
    expect(getSettings({ debug: true }).logLevel).toBe("debug");
  });

  it("prefers logLevel over legacy debug", () => {
    expect(getSettings({ logLevel: "warn", debug: true }).logLevel).toBe("warn");
  });

  it("falls back to silent for invalid levels", () => {
    expect(getSettings({ logLevel: "verbose" as never }).logLevel).toBe("silent");
  });
});
