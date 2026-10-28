import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream } from "./append-stream";
import { sendReply, type ReplyChannel } from "./outbound";
import type { ReplyBudget } from "./reply-budget";

/**
 * F7 长任务反馈：run 级状态机（追加语义版）。
 *
 * 场景：user_input → thinking+tools（10~60 分钟）→ assistant message。
 * 流式采用 AppendStream（input_mode="append"）：平台规则"已提交内容不可修改"，
 * 因此心跳行、结果文本按顺序**追加**进同一条流气泡；任何一帧失败即标 dead，
 * 回退到消息路径（结果永远有 sendReply 兜底，流只是附加展示）。
 *
 * 生命周期由 index.ts 驱动：
 *   inbound.markQQTrigger → pi.on("agent_start") → onAgentStart
 *   → pi.on("tool_execution_end") → onToolEnd（只计数，不外发）
 *   → 心跳定时器 → beat()
 *   → pi.on("message_update"/"message_end") → 结果文本增量追加
 *   → pi.on("agent_end") → onAgentEnd（发 DONE/清 timer）
 */

export interface ToolStat {
  count: number;
  errors: number;
}

export interface RunFeedbackDeps {
  bot: () => QQBot | undefined;
  budget: ReplyBudget;
  boundOpenid: () => string | undefined;
  getHeartbeatMinutes: () => number;
  getHeartbeatMaxMessages: () => number;
  /** 流式载体总开关（默认关：append 语义需实测通过后再开启） */
  getStreamRelay: () => boolean;
  makeChannel: () => ReplyChannel;
  onWarn: (msg: string) => void;
}

interface RunState {
  startedAt: number;
  openid: string;
  msgId?: string;
  tools: Map<string, ToolStat>;
  stream: AppendStream | null;
  streamState: "unopened" | "open" | "dead";
  /** 结果文本已追加到流的长度（用于计算增量） */
  resultSentLen: number;
  /** 流中是否已有内容（决定结果追加前是否补空行） */
  streamHasContent: boolean;
  /** 已完成 assistant 消息的累计文本 */
  finalizedText: string;
  typingTimer?: ReturnType<typeof setInterval>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  messageHeartbeats: number;
}

/** 心跳文案：仅工具名×次数与时长，无参数无响应（features.md 决策 #3） */
export function formatHeartbeat(elapsedMs: number, tools: Map<string, ToolStat>): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  const elapsedText = minutes < 1 ? "不到 1 分钟" : `${minutes} 分钟`;
  if (tools.size === 0) return `⏱ 已运行 ${elapsedText}（尚未产生工具调用）`;
  const parts = [...tools.entries()].map(([name, s]) => `${name}×${s.count}`);
  const errors = [...tools.values()].reduce((n, s) => n + s.errors, 0);
  const suffix = errors > 0 ? ` · ${errors} 失败` : "";
  return `⏱ 已运行 ${elapsedText} · ${parts.join(" · ")}${suffix}`;
}

const TYPING_INTERVAL_MS = 50_000; // 平台 typing 窗口 ~60s，提前续期
const PENDING_TTL_MS = 15_000; // QQ 触发标记的有效期（超过视为本地 run）

export class RunFeedback {
  private readonly deps: RunFeedbackDeps;
  private pending: { openid: string; msgId: string; at: number } | null = null;
  private run: RunState | null = null;

  constructor(deps: RunFeedbackDeps) {
    this.deps = deps;
  }

  /** inbound 在注入 pi 前调用：标记接下来的 run 由 QQ 触发 */
  markQQTrigger(openid: string, msgId: string): void {
    this.pending = { openid, msgId, at: Date.now() };
  }

  onAgentStart(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return; // 非 QQ 触发
    const bot = this.deps.bot();
    if (!bot) return;

    const hbMinutes = this.deps.getHeartbeatMinutes();
    const run: RunState = {
      startedAt: Date.now(),
      openid: pending.openid,
      msgId: pending.msgId,
      tools: new Map(),
      stream: null,
      streamState: "unopened",
      resultSentLen: 0,
      streamHasContent: false,
      finalizedText: "",
      messageHeartbeats: 0,
    };
    this.run = run;

    // typing 保鲜：run 期间持续"正在输入"，0 额度
    run.typingTimer = setInterval(() => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    }, TYPING_INTERVAL_MS);

    // 节流心跳
    if (hbMinutes > 0) {
      run.heartbeatTimer = setInterval(() => {
        void this.beat();
      }, hbMinutes * 60_000);
    }
  }

  /** 只计数（工具名×次数），不外发 —— features.md 决策 #3 */
  onToolEnd(toolName: string, isError: boolean): void {
    const run = this.run;
    if (!run) return;
    const stat = run.tools.get(toolName) ?? { count: 0, errors: 0 };
    stat.count += 1;
    if (isError) stat.errors += 1;
    run.tools.set(toolName, stat);
  }

  /** assistant 文本流式快照（message_update）：streamRelay 开启时增量追加进流 */
  async onAssistantDelta(snapshotText: string): Promise<void> {
    const run = this.run;
    if (!run || run.streamState === "dead") return;
    if (!this.deps.getStreamRelay()) return;
    const full = [run.finalizedText, snapshotText].filter((s) => s.trim()).join("\n\n");
    if (full.length <= run.resultSentLen) return;
    const delta = full.slice(run.resultSentLen);
    const prefix = run.resultSentLen === 0 && run.streamHasContent ? "\n" : "";
    if (await this.pushAppend(run, prefix + delta)) {
      run.resultSentLen = full.length;
    }
  }

  /**
   * assistant 消息定稿（message_end）。
   * 仅 streamRelay 开启时才可能由流接管（返回 true，调用方跳过 sendReply）；
   * 默认返回 false：结果永远走可靠的消息路径（流只是附加展示，不吞掉结果）。
   */
  async onAssistantFinal(text: string, isError: boolean): Promise<boolean> {
    const run = this.run;
    if (!run) return false;

    if (isError) {
      // 出错即弃流，错误摘要交回调用方走预算链路
      run.streamState = "dead";
      run.stream = null;
      return false;
    }

    if (!this.deps.getStreamRelay()) return false;

    run.finalizedText = [run.finalizedText, text].filter((s) => s.trim()).join("\n\n");
    if (run.streamState === "dead") return false;

    const full = run.finalizedText;
    if (full.length > run.resultSentLen) {
      const delta = full.slice(run.resultSentLen);
      const prefix = run.resultSentLen === 0 && run.streamHasContent ? "\n" : "";
      if (!(await this.pushAppend(run, prefix + delta))) return false;
      run.resultSentLen = full.length;
    }
    return true; // 已由流接管（agent_end 发 DONE）
  }

  /** run 结束：清定时器、给流发 DONE */
  async onAgentEnd(): Promise<void> {
    const run = this.run;
    this.clearTimers();
    this.run = null;
    if (run?.stream && run.streamState === "open") {
      // DONE 失败不补发——内容已随追加帧展示（避免双发）
      try {
        await run.stream.done();
      } catch {}
    }
  }

  /** session_shutdown 等异常路径的清理 */
  dispose(): void {
    this.clearTimers();
    this.run?.stream?.dispose();
    this.run = null; // 未发 DONE 的气泡会停留在生成态（追加模式无撤销语义，可接受）
  }

  private clearTimers(): void {
    const run = this.run;
    if (!run) return;
    if (run.typingTimer) clearInterval(run.typingTimer);
    if (run.heartbeatTimer) clearInterval(run.heartbeatTimer);
    run.typingTimer = undefined;
    run.heartbeatTimer = undefined;
  }

  /** 心跳：streamRelay 开启时流式优先（同一条气泡持续追加），降级消息心跳（保险丝 ≤N 条） */
  private async beat(): Promise<void> {
    const run = this.run;
    if (!run) return;
    const line = formatHeartbeat(Date.now() - run.startedAt, run.tools);
    if (this.deps.getStreamRelay() && run.streamState !== "dead" && (await this.pushAppend(run, `${line}\n`))) {
      return;
    }

    // 流不可用 → 消息心跳（保险丝）
    if (run.messageHeartbeats >= this.deps.getHeartbeatMaxMessages()) return;
    const bound = this.deps.boundOpenid();
    if (!bound) return;
    const bot = this.deps.bot();
    if (!bot) return;
    run.messageHeartbeats += 1;
    await sendReply(bot, line, this.deps.makeChannel());
  }

  /** 追加一帧（惰性建流）；失败标 dead 并返回 false */
  private async pushAppend(run: RunState, delta: string): Promise<boolean> {
    if (!delta) return true;
    const bot = this.deps.bot();
    if (!bot) return false;
    try {
      if (!run.stream) {
        if (!run.msgId) return false;
        run.stream = new AppendStream(bot.messageApi, bot.getCredentials(), run.openid, run.msgId, {
          onError: (err) => this.handleStreamError(run, err),
        });
        run.streamState = "open";
      }
      await run.stream.append(delta);
      return true;
    } catch (err) {
      this.handleStreamError(run, err as Error);
      return false;
    }
  }

  /** 流不可信：标记降级，并把尚未追加到流的结果文本用消息路径补发（避免结果丢失） */
  private handleStreamError(run: RunState, err: Error): void {
    const wasDead = run.streamState === "dead";
    run.streamState = "dead";
    run.stream = null;
    if (!wasDead) this.deps.onWarn(`流式通道不可用，已降级（${err.message}）`);
    const rest = run.finalizedText.slice(run.resultSentLen);
    if (rest) {
      const bound = this.deps.boundOpenid();
      const bot = this.deps.bot();
      if (bound && bot) {
        run.resultSentLen = run.finalizedText.length;
        void sendReply(bot, rest, this.deps.makeChannel());
      }
    }
  }
}
