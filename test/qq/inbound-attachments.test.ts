import { beforeEach, describe, expect, it } from "vitest";
import { configureI18n } from "../../src/infra/i18n";
import { PendingAttachments } from "../../src/qq/inbound-attachments";

beforeEach(() => configureI18n("en-us"));

describe("PendingAttachments", () => {
  it("caps the queue and drops the oldest files", () => {
    const now = 0;
    const pending = new PendingAttachments({ maxFiles: 2, ttlMs: 100, now: () => now });
    expect(pending.add([{ path: "a" }])).toEqual({ accepted: 1, dropped: 0 });
    expect(pending.add([{ path: "b" }])).toEqual({ accepted: 1, dropped: 0 });
    expect(pending.add([{ path: "c" }])).toEqual({ accepted: 1, dropped: 1 });
    expect(pending.count).toBe(2);
    expect(pending.take().map((file) => file.path)).toEqual(["b", "c"]);
  });

  it("expires entries after the TTL", () => {
    let now = 0;
    const pending = new PendingAttachments({ ttlMs: 100, now: () => now });
    pending.add([{ path: "a" }]);
    now = 100;
    expect(pending.count).toBe(1);
    now = 101;
    expect(pending.count).toBe(0);
    expect(pending.take()).toEqual([]);
  });
});
