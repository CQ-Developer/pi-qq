import { t } from "../infra/i18n";
import type { BudgetSnapshot } from "./reply-quota";

interface BudgetTarget {
  openid: string;
  msgId: string;
  arrivedAt: number;
}

function mask(value: string): string {
  return `${value.slice(0, 8)}…`;
}

export function formatBudgetStatus(
  snapshot: BudgetSnapshot,
  last: BudgetTarget | undefined,
  now = Date.now(),
): string[] {
  const ageSec = last ? Math.max(0, Math.floor((now - last.arrivedAt) / 1000)) : null;
  const estimated = snapshot.hasTarget ? Math.max(0, snapshot.remaining - snapshot.streamBubbles) : null;

  const lastLine = last
    ? t("diagnostics.budget.lastInbound", {
        openid: mask(last.openid),
        msgId: mask(last.msgId),
        age: ageSec ?? 0,
      })
    : t("diagnostics.budget.lastInboundNone");

  const remainingLine = snapshot.hasTarget
    ? t("diagnostics.budget.passiveRemaining", { remaining: snapshot.remaining })
    : t("diagnostics.budget.passiveRemainingNone");

  const estimatedLine =
    estimated === null
      ? t("diagnostics.budget.estimatedNone")
      : t("diagnostics.budget.estimated", { remaining: estimated });

  const windowLine = snapshot.hasTarget
    ? t("diagnostics.budget.window", {
        window: snapshot.fresh ? t("diagnostics.budget.valid") : t("diagnostics.budget.expired"),
      })
    : t("diagnostics.budget.windowNone");

  return [
    t("diagnostics.budget.title"),
    t("diagnostics.budget.limit", { limit: snapshot.limit, hours: snapshot.ttlHours }),
    lastLine,
    remainingLine,
    t("diagnostics.budget.streamBubbles", { count: snapshot.streamBubbles }),
    estimatedLine,
    windowLine,
    t("diagnostics.budget.recorded", {
      passive: snapshot.totalReplies,
      stream: snapshot.streamBubblesTotal,
      tracked: snapshot.trackedMessages,
    }),
  ];
}
