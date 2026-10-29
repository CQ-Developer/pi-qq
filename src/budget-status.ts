import type { BudgetSnapshot } from "./reply-budget";

export interface BudgetTarget {
  openid: string;
  msgId: string;
  arrivedAt: number;
}

function mask(value: string): string {
  return `${value.slice(0, 8)}…`;
}

/** Render `/qq-budget` output lines; pure function for tests. */
export function formatBudgetStatus(
  snapshot: BudgetSnapshot,
  last: BudgetTarget | undefined,
  now = Date.now(),
): string[] {
  const ageSec = last ? Math.max(0, Math.floor((now - last.arrivedAt) / 1000)) : null;
  const estimated = snapshot.hasTarget ? Math.max(0, snapshot.remaining - snapshot.streamBubbles) : null;

  return [
    "pi-qq passive reply budget",
    `Limit: ${snapshot.limit}/msg (${snapshot.ttlHours}h)`,
    `Last inbound: ${last ? `${mask(last.openid)} / ${mask(last.msgId)}, ${ageSec}s ago` : "none"}`,
    `Passive remaining: ${snapshot.hasTarget ? snapshot.remaining : "—"}`,
    `Stream bubbles: ${snapshot.streamBubbles} (current msgId)`,
    `Estimated remaining: ${estimated ?? "—"} (diagnostic only)`,
    `msgId window: ${snapshot.hasTarget ? (snapshot.fresh ? "valid" : "expired") : "—"}`,
    `Recorded: passive ${snapshot.totalReplies} / stream ${snapshot.streamBubblesTotal} / ${snapshot.trackedMessages} msgId(s)`,
  ];
}
