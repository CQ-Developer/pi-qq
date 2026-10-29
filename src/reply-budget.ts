import { ReplyLimiter } from "@tencent-connect/qqbot-nodejs/protocol";

/**
 * Passive reply budget (features.md §3).
 *
 * QQ allows about 4 passive replies per inbound message (SDK ReplyLimiter default
 * 4/1h); a msgId is usable for about 5 minutes after arrival. Over-limit or stale
 * sends fall back to proactive mode. Counting reuses the SDK ReplyLimiter.
 */

export type ReplyMode = "passive" | "proactive";

export interface AcquireResult {
  mode: ReplyMode;
  /** Sender of the latest inbound message; the caller falls back to the bound openid. */
  openid?: string;
  /** Present when mode=passive. */
  msgId?: string;
}

export interface BudgetSnapshot {
  hasTarget: boolean;
  fresh: boolean;
  ageMs: number | null;
  limit: number;
  ttlHours: number;
  remaining: number;
  totalReplies: number;
  trackedMessages: number;
  /** Stream bubbles created for the current msgId (diagnostic only, not used by acquire). */
  streamBubbles: number;
  /** Total stream bubbles in this process. */
  streamBubblesTotal: number;
}

export class ReplyBudget {
  private readonly limiter: ReplyLimiter;
  private readonly freshMs: number;
  private last: { openid: string; msgId: string; arrivedAt: number } | undefined;
  private streamMsgId: string | undefined;
  private streamBubbles = 0;
  private streamBubblesTotal = 0;

  constructor(opts?: { limit?: number; freshMs?: number }) {
    this.limiter = new ReplyLimiter({ limit: opts?.limit ?? 4 });
    this.freshMs = opts?.freshMs ?? 5 * 60_000;
  }

  /** Called on inbound: update the passive target and freshness start. */
  observeInbound(openid: string, msgId: string, now = Date.now()): void {
    if (this.last?.msgId !== msgId) {
      this.streamMsgId = msgId;
      this.streamBubbles = 0;
    }
    this.last = { openid, msgId, arrivedAt: now };
  }

  /** Latest inbound target (diagnostics/passive sends). */
  get lastTarget(): { openid: string; msgId: string; arrivedAt: number } | undefined {
    return this.last;
  }

  /**
   * Pick the send mode for the next message. Passive only checks; callers must
   * call commitPassive() after a successful passive send.
   */
  acquire(now = Date.now()): AcquireResult {
    const last = this.last;
    if (!last) return { mode: "proactive" };
    const fresh = now - last.arrivedAt <= this.freshMs;
    if (fresh && this.limiter.checkLimit(last.msgId).allowed) {
      return { mode: "passive", openid: last.openid, msgId: last.msgId };
    }
    return { mode: "proactive", openid: last.openid };
  }

  /** Record a successful passive send. */
  commitPassive(msgId: string): void {
    this.limiter.record(msgId);
  }

  /** Diagnostic: record one new stream bubble (does not affect passive limits). */
  noteStreamBubble(msgId: string): void {
    if (this.streamMsgId !== msgId) {
      this.streamMsgId = msgId;
      this.streamBubbles = 0;
    }
    this.streamBubbles += 1;
    this.streamBubblesTotal += 1;
  }

  /** Diagnostic snapshot: passive budget, target freshness, and send counts. */
  snapshot(now = Date.now()): BudgetSnapshot {
    const config = this.limiter.getConfig();
    const stats = this.limiter.getStats();
    if (!this.last) {
      return {
        hasTarget: false,
        fresh: false,
        ageMs: null,
        limit: config.limit,
        ttlHours: config.ttlHours,
        remaining: 0,
        streamBubbles: 0,
        streamBubblesTotal: this.streamBubblesTotal,
        ...stats,
      };
    }

    const ageMs = Math.max(0, now - this.last.arrivedAt);
    return {
      hasTarget: true,
      fresh: ageMs <= this.freshMs,
      ageMs,
      limit: config.limit,
      ttlHours: config.ttlHours,
      remaining: this.limiter.checkLimit(this.last.msgId).remaining,
      streamBubbles: this.streamMsgId === this.last.msgId ? this.streamBubbles : 0,
      streamBubblesTotal: this.streamBubblesTotal,
      ...stats,
    };
  }
}
