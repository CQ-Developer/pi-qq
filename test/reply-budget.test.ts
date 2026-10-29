import { describe, expect, it } from "vitest";
import { ReplyBudget } from "../src/reply-budget";

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
});
