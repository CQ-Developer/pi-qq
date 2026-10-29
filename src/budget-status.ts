import type { BudgetSnapshot } from "./reply-budget";

export interface BudgetTarget {
  openid: string;
  msgId: string;
  arrivedAt: number;
}

function mask(value: string): string {
  return `${value.slice(0, 8)}…`;
}

/** 生成 `/qq-budget` 的显示行；纯函数便于单测 */
export function formatBudgetStatus(
  snapshot: BudgetSnapshot,
  last: BudgetTarget | undefined,
  now = Date.now(),
): string[] {
  const ageSec = last ? Math.max(0, Math.floor((now - last.arrivedAt) / 1000)) : null;
  const estimated = snapshot.hasTarget ? Math.max(0, snapshot.remaining - snapshot.streamBubbles) : null;

  return [
    "pi-qq 被动回复预算",
    `上限：${snapshot.limit} 条/msg（${snapshot.ttlHours}h）`,
    `最近入站：${last ? `${mask(last.openid)} / ${mask(last.msgId)}，${ageSec}s 前` : "无"}`,
    `普通被动剩余：${snapshot.hasTarget ? snapshot.remaining : "—"}`,
    `流式气泡：${snapshot.streamBubbles} 条（当前 msgId）`,
    `估算剩余：${estimated ?? "—"} 条（仅诊断）`,
    `msgId 窗口：${snapshot.hasTarget ? (snapshot.fresh ? "有效" : "已过期") : "—"}`,
    `已记录：普通 ${snapshot.totalReplies} 条 / 流式 ${snapshot.streamBubblesTotal} 条 / 跟踪 ${snapshot.trackedMessages} 个 msgId`,
  ];
}
