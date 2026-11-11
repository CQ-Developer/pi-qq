import { describe, expect, it } from "vitest";
import { logMessageKey } from "../../src/infra/log-message-keys";

describe("log message keys", () => {
  it("maps known messages to stable keys", () => {
    expect(logMessageKey("starting bot")).toBe("log.sessionStartingBot");
  });

  it("leaves unknown messages without a key", () => {
    expect(logMessageKey("unknown SDK message")).toBeUndefined();
  });
});
