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

export class ReplyBudget {
  private readonly limiter: ReplyLimiter;
  private readonly freshMs: number;
  private last: { openid: string; msgId: string; arrivedAt: number } | undefined;

  constructor(opts?: { limit?: number; freshMs?: number }) {
    this.limiter = new ReplyLimiter({ limit: opts?.limit ?? 4 });
    this.freshMs = opts?.freshMs ?? 5 * 60_000;
  }

  /** 入站消息到达时调用：更新被动回复目标与其新鲜度起点 */
  observeInbound(openid: string, msgId: string, now = Date.now()): void {
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
}
