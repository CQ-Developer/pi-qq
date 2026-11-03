import { ReplyLimiter } from "@tencent-connect/qqbot-nodejs/protocol";

export type ReplyMode = "passive" | "proactive";

export interface AcquireResult {
  mode: ReplyMode;
  openid?: string;
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
  streamBubbles: number;
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

  observeInbound(openid: string, msgId: string, now = Date.now()): void {
    if (this.last?.msgId !== msgId) {
      this.streamMsgId = msgId;
      this.streamBubbles = 0;
    }
    this.last = { openid, msgId, arrivedAt: now };
  }

  get lastTarget(): { openid: string; msgId: string; arrivedAt: number } | undefined {
    return this.last;
  }

  acquire(now = Date.now()): AcquireResult {
    const last = this.last;
    if (!last) return { mode: "proactive" };
    const fresh = now - last.arrivedAt <= this.freshMs;
    if (fresh && this.limiter.checkLimit(last.msgId).allowed) {
      return { mode: "passive", openid: last.openid, msgId: last.msgId };
    }
    return { mode: "proactive", openid: last.openid };
  }

  commitPassive(msgId: string): void {
    this.limiter.record(msgId);
  }

  noteStreamBubble(msgId: string): void {
    if (this.streamMsgId !== msgId) {
      this.streamMsgId = msgId;
      this.streamBubbles = 0;
    }
    this.streamBubbles += 1;
    this.streamBubblesTotal += 1;
  }

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
