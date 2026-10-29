import type { ContextUsage } from "@earendil-works/pi-coding-agent";

/**
 * F5/F6 用量摘要：本次 agent run 的累计输入/输出/缓存命中率 + 当前上下文占比。
 *
 * pi 的 ExtensionContext 没有现成的 token 总和；只能从消息的 `usage`
 * 字段聚合。这里按 agent_end 的 `event.messages` 统计本次 run：
 * assistant 消息 + toolResult 自带的嵌套 usage（如 codemode/subagent）。
 */

/** 只依赖 message.usage 的结构化子集，便于单测与跨版本兼容 */
export interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 供 sumUsageMessages 使用的最小消息结构（不直接依赖 AgentMessage 导出） */
export interface UsageMessageLike {
  role: string;
  usage?: UsageLike | null;
}

export interface UsageSummaryInput {
  /** 本次 agent run 的累计用量 */
  usage: UsageTotals;
  context?: ContextUsage;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** 累加一次 usage，返回新对象（不修改入参） */
export function addUsage(totals: UsageTotals, usage: UsageLike | null | undefined): UsageTotals {
  if (!usage) return totals;
  return {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
  };
}

/** 汇总本次 run 的消息用量：assistant + toolResult 的嵌套 usage */
export function sumUsageMessages(messages: readonly UsageMessageLike[]): UsageTotals {
  let totals = emptyUsageTotals();
  for (const message of messages) {
    if (message.role === "assistant" || message.role === "toolResult") {
      totals = addUsage(totals, message.usage);
    }
  }
  return totals;
}

export function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

function formatContextPercent(context: ContextUsage | undefined): string {
  if (!context) return "未知";
  if (context.tokens === null) return "重建中";

  const percent =
    context.percent ?? (context.contextWindow > 0 ? (context.tokens / context.contextWindow) * 100 : null);
  return percent === null ? "未知" : formatPercent(percent);
}

/** 生成严格三行的用量摘要 */
export function formatUsageSummary(input: UsageSummaryInput): string {
  const { usage, context } = input;
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  const cacheHitRate = totalInput > 0 ? (usage.cacheRead / totalInput) * 100 : 0;

  return [
    "📊 用量摘要",
    `• 输入：${formatTokenCount(totalInput)} (${formatPercent(cacheHitRate)})`,
    `• 输出：${formatTokenCount(usage.output)}`,
    `• 上下文：${formatContextPercent(context)}`,
  ].join("\n");
}
