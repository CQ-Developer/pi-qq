import { ReplyLimiter } from "@tencent-connect/qqbot-nodejs/protocol";

/**
 * 被动回复预算（features.md §3）。
 *
 * QQ 平台限制：每条入站消息最多约 4 条被动回复（SDK ReplyLimiter 默认 4 条/1h），
 * 且 msgId 仅在到达后约 5 分钟内可用作被动回复引用；超限或过期一律降级为主动发送。
 * 计数复用 SDK 的 ReplyLimiter（@tencent-connect/qqbot-nodejs/protocol 子导出）。
 */

export type ReplyMode = "passive" | "proactive";

export interface AcquireResult {
  mode: ReplyMode;
  /** 最近一次入站消息的发送者；无入站记录时缺省，由调用方用绑定 openid 兜底 */
  openid?: string;
  /** mode=passive 时存在 */
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
  /** 当前 msgId 下已创建的流式气泡数（诊断用，不计入 acquire） */
  streamBubbles: number;
  /** 本进程累计流式气泡数 */
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

  /** 入站消息到达时调用：更新被动回复目标与其新鲜度起点 */
  observeInbound(openid: string, msgId: string, now = Date.now()): void {
    if (this.last?.msgId !== msgId) {
      this.streamMsgId = msgId;
      this.streamBubbles = 0;
    }
    this.last = { openid, msgId, arrivedAt: now };
  }

  /** 最近一次入站消息目标（诊断命令/被动回复用） */
  get lastTarget(): { openid: string; msgId: string; arrivedAt: number } | undefined {
    return this.last;
  }

  /**
   * 为下一条待发送消息取发送模式。passive 只检查不计数，
   * 发送成功后须调用 commitPassive() 记账。
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

  /** 被动回复发送成功后记账 */
  commitPassive(msgId: string): void {
    this.limiter.record(msgId);
  }

  /** 诊断：记录新建的一条流式气泡（不参与被动额度判定） */
  noteStreamBubble(msgId: string): void {
    if (this.streamMsgId !== msgId) {
      this.streamMsgId = msgId;
      this.streamBubbles = 0;
    }
    this.streamBubbles += 1;
    this.streamBubblesTotal += 1;
  }

  /** 诊断快照：被动额度、最近目标新鲜度与累计发送数 */
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
