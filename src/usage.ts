import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * F5/F6 用量摘要：会话累计、最后一轮 usage、上下文占比。
 *
 * 口径与 pi 会话统计一致：assistant 消息、usage 类条目、compaction/branch summary、
 * 以及 toolResult 自带的嵌套 usage 都计入会话累计；`本轮` 只取最后一条 assistant
 * 消息的 `usage.totalTokens`。摘要固定为一帧文本，经 reply-budget 链路发送。
 */

/** 只依赖 message.usage 的结构化子集，便于单测与跨版本兼容 */
export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: { total?: number } | null;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface UsageSummaryInput {
  session: UsageTotals;
  /** 最后一轮 assistant usage；null 时不显示“本轮” */
  turn: UsageLike | null;
  context?: ContextUsage;
  contextWarnPercent: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** 累加一次 usage，返回新对象（不修改入参） */
export function addUsage(totals: UsageTotals, usage: UsageLike | null | undefined): UsageTotals {
  if (!usage) return totals;
  return {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    cost: totals.cost + (usage.cost?.total ?? 0),
  };
}

/** 从会话分支条目重建累计（口径对齐 pi 的 session stats） */
export function collectUsageFromEntries(entries: readonly SessionEntry[]): UsageTotals {
  let totals = emptyUsageTotals();
  for (const entry of entries) {
    if (entry.type === "usage") {
      totals = addUsage(totals, entry.usage);
      continue;
    }
    if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      totals = addUsage(totals, entry.usage);
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message.role === "assistant") {
      totals = addUsage(totals, message.usage);
    } else if (message.role === "toolResult" && message.usage) {
      totals = addUsage(totals, message.usage);
    }
  }
  return totals;
}

export function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

export function formatCost(cost: number): string {
  const fixed = cost >= 1 ? cost.toFixed(2) : cost.toFixed(4);
  return `$${fixed.replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatPercent(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`;
}

function usageTotal(usage: UsageLike): number {
  return usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatContext(context: ContextUsage, warnPercent: number): string {
  if (context.tokens === null) return " | 上下文 重建中";

  const percent =
    context.percent ??
    (context.contextWindow > 0 ? (context.tokens / context.contextWindow) * 100 : null);
  let text = ` | 上下文 ${formatTokenCount(context.tokens)}/${formatTokenCount(context.contextWindow)}`;
  if (percent !== null) {
    text += `（${formatPercent(percent)}）`;
    if (percent >= warnPercent) text += "· 建议 /compact";
  }
  return text;
}

/** 生成一条用量摘要文本 */
export function formatUsageSummary(input: UsageSummaryInput): string {
  const { session, turn, context, contextWarnPercent } = input;
  let text = `📊 tokens — 输入 ${formatTokenCount(session.input)}`;
  if (session.cacheRead > 0) {
    text += `（缓存命中 ${formatTokenCount(session.cacheRead)}）`;
  }
  text += `${session.cacheRead > 0 ? "·" : " ·"} 输出 ${formatTokenCount(session.output)}`;
  if (session.cost > 0) {
    text += ` · 成本 ${formatCost(session.cost)}`;
  }
  if (turn) {
    text += ` · 本轮 ${formatTokenCount(usageTotal(turn))}`;
  }
  if (context) {
    text += formatContext(context, contextWarnPercent);
  }
  return text;
}

/** 会话级累计 + 当前 run 最后一轮 usage；由 index.ts 在生命周期事件中驱动 */
export class UsageTracker {
  private totals = emptyUsageTotals();
  private lastTurn: UsageLike | null = null;

  /** session_start：从当前分支重建（/new 时传空数组即清零） */
  rebuild(entries: readonly SessionEntry[]): void {
    this.totals = collectUsageFromEntries(entries);
    this.lastTurn = null;
  }

  /** agent_end：用已持久化的分支刷新累计（补上 cache warm/compaction/toolResult 等），保留“本轮” */
  refresh(entries: readonly SessionEntry[]): void {
    this.totals = collectUsageFromEntries(entries);
  }

  /** agent_start：新一轮开始，清空“本轮” */
  startRun(): void {
    this.lastTurn = null;
  }

  /** turn_end（assistant）：记录最后一轮并累加进会话累计 */
  noteTurn(usage: UsageLike | null | undefined): void {
    if (!usage) return;
    this.lastTurn = usage;
    this.totals = addUsage(this.totals, usage);
  }

  getTotals(): UsageTotals {
    return { ...this.totals };
  }

  getLastTurn(): UsageLike | null {
    return this.lastTurn;
  }
}
