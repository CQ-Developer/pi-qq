import { describe, expect, it } from "vitest";
import { ReplyBudget, type BudgetSnapshot } from "../src/reply-budget";
import { formatBudgetStatus } from "../src/budget-status";

const t0 = 1_700_000_000_000;

describe("ReplyBudget", () => {
  it("无入站记录 → proactive", () => {
    expect(new ReplyBudget().acquire(t0).mode).toBe("proactive");
  });

  it("新鲜入站 → passive", () => {
    const budget = new ReplyBudget();
    budget.observeInbound("openid-U", "msg-1", t0);
    expect(budget.acquire(t0)).toEqual({ mode: "passive", openid: "openid-U", msgId: "msg-1" });
  });

  it("同一 msgId 第 5 次被动后降级", () => {
    const budget = new ReplyBudget();
    budget.observeInbound("openid-U", "msg-x", t0);
    for (let i = 0; i < 4; i++) {
      const result = budget.acquire(t0);
      expect(result.mode).toBe("passive");
      budget.commitPassive(result.msgId!);
    }
    expect(budget.acquire(t0).mode).toBe("proactive");
  });

  it("msgId 超 5 分钟过期，5 分钟内仍可被动", () => {
    const budget = new ReplyBudget();
    budget.observeInbound("openid-U", "msg-stale", t0);
    expect(budget.acquire(t0 + 6 * 60_000).mode).toBe("proactive");
    expect(budget.acquire(t0 + 4 * 60_000).mode).toBe("passive");
  });

  it("新 msgId 独立额度", () => {
    const budget = new ReplyBudget();
    budget.observeInbound("openid-U", "msg-fresh-2", t0);
    const result = budget.acquire(t0);
    expect(result.mode).toBe("passive");
    expect(result.msgId).toBe("msg-fresh-2");
  });

  it("诊断快照：无目标/新建/记账/过期", () => {
    const budget = new ReplyBudget();
    expect(budget.snapshot(t0).hasTarget).toBe(false);

    budget.observeInbound("openid-U", "msg-snap", t0);
    const initial = budget.snapshot(t0);
    expect(initial.hasTarget).toBe(true);
    expect(initial.fresh).toBe(true);
    expect(initial.remaining).toBe(4);

    budget.commitPassive("msg-snap");
    const after = budget.snapshot(t0);
    expect(after.remaining).toBe(3);
    expect(after.totalReplies).toBe(1);
    expect(budget.snapshot(t0 + 6 * 60_000).fresh).toBe(false);
  });

  it("流式气泡计数按 msgId 归属，总数跨 msgId 累计", () => {
    const budget = new ReplyBudget();
    budget.observeInbound("openid-U", "msg-stream", t0);
    budget.noteStreamBubble("msg-stream");
    budget.noteStreamBubble("msg-stream");
    const current = budget.snapshot(t0);
    expect(current.streamBubbles).toBe(2);
    expect(current.streamBubblesTotal).toBe(2);

    budget.observeInbound("openid-U", "msg-next", t0);
    const next = budget.snapshot(t0);
    expect(next.streamBubbles).toBe(0);
    expect(next.streamBubblesTotal).toBe(2);
  });
});

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
