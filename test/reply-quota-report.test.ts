import { describe, expect, it } from "vitest";
import type { BudgetSnapshot } from "../src/reply-quota";
import { formatBudgetStatus } from "../src/reply-quota-report";

const t0 = 1_700_000_000_000;

describe("formatBudgetStatus", () => {
  const snapshot: BudgetSnapshot = {
    hasTarget: true,
    fresh: true,
    ageMs: 12_000,
    limit: 4,
    ttlHours: 1,
    remaining: 3,
    totalReplies: 1,
    trackedMessages: 1,
    streamBubbles: 2,
    streamBubblesTotal: 5,
  };
  const last = { openid: "openid-12345678", msgId: "msg-12345678", arrivedAt: t0 };

  it("有目标时展示普通/流式/估算剩余", () => {
    expect(formatBudgetStatus(snapshot, last, t0 + 12_000)).toEqual([
      "pi-qq passive reply budget",
      "Limit: 4/msg (1h)",
      "Last inbound: openid-1… / msg-1234…, 12s ago",
      "Passive remaining: 3",
      "Stream bubbles: 2 (current msgId)",
      "Estimated remaining: 1 (diagnostic only)",
      "msgId window: valid",
      "Recorded: passive 1 / stream 5 / 1 msgId(s)",
    ]);
  });

  it("无目标时显示占位符", () => {
    const empty: BudgetSnapshot = {
      hasTarget: false,
      fresh: false,
      ageMs: null,
      limit: 4,
      ttlHours: 1,
      remaining: 0,
      totalReplies: 0,
      trackedMessages: 0,
      streamBubbles: 0,
      streamBubblesTotal: 0,
    };
    expect(formatBudgetStatus(empty, undefined, t0)).toEqual([
      "pi-qq passive reply budget",
      "Limit: 4/msg (1h)",
      "Last inbound: none",
      "Passive remaining: —",
      "Stream bubbles: 0 (current msgId)",
      "Estimated remaining: — (diagnostic only)",
      "msgId window: —",
      "Recorded: passive 0 / stream 0 / 0 msgId(s)",
    ]);
  });
});
