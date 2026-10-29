import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream } from "./append-stream";
import { sendReply, type ReplyChannel } from "./outbound";
import type { ReplyBudget } from "./reply-budget";

/**
 * F7 长任务反馈：run 级状态机（汇总帧 + 文本气泡切分版）。
 *
 * 场景：user_input → thinking+tools（10~60 分钟）→ assistant message，n 轮循环。
 *
 * 气泡切分规则：**assistant 文本消息与思考/工具汇总使用独立气泡**。
 * 文本消息（同一 assistant 消息的流式增量）独占一个文本气泡；思考/工具行组进入
 * 活动气泡。文本首个增量到达时封口当前活动气泡；工具/思考出现时封口当前文本气泡，
 * 新行组进新的活动气泡；最终回复独立成文本气泡。气泡内按 `streamFlushMs`
 * （默认 10000ms）固定频率发送窗口汇总帧：
 *
 *   活动气泡：💭 思考中... / [2] 🔧 bash（行组外层带 [HH:MM:SS] 时间戳）
 *   文本气泡：消息原文（流式增量，按 markdown 渲染）
 *
 * 任何一帧失败即弃气泡：未发出的结果文本自动转消息路径补发；下一个文本消息重试新气泡。
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
  /** 流式汇总帧间隔（毫秒，最小 300） */
  getStreamFlushMs: () => number;
  getStreamRelay: () => boolean;
  /** 诊断模式：SDK 日志转终端 + 文本帧也带时间戳 */
  getDebug: () => boolean;
  makeChannel: () => ReplyChannel;
  onWarn: (msg: string) => void;
}

interface ToolStat2 {
  count: number;
  errors: number;
}

/** 当前气泡：一条独立流式消息；kind 决定它只接收文本还是思考/工具行组 */
interface Bubble {
  stream: AppendStream;
  kind: "activity" | "text";
}

interface RunState {
  startedAt: number;
  openid: string;
  msgId?: string;
  /** 工具总计（心跳 ⏱ 行用） */
  tools: Map<string, ToolStat2>;
  /** 本窗口出现思考（flush 后复位） */
  winThinking: boolean;
  /** 本消息已打过思考标记（逐消息复位，避免长思考刷屏） */
  thinkingMarked: boolean;
  /** 本窗口工具计数（flush 后清空） */
  winTools: Map<string, number>;
  /** 当前流式文本快照（message_update 更新） */
  snapshotText: string;
  /** 已定稿 assistant 消息累计文本 */
  finalizedText: string;
  /** 已追加到流的结果文本长度（增量计算基准，跨气泡累计） */
  resultSentLen: number;
  /** 上一条文本消息已定稿：下一条文本消息首个增量到达时封口当前文本气泡 */
  startNewBubble: boolean;
  /** 当前气泡（null = 待惰性创建） */
  cur: Bubble | null;
  /** 最近一次成功追加的时间戳（空窗口活性线用） */
  lastAppendAt: number;
  typingTimer?: ReturnType<typeof setInterval>;
  flushTimer?: ReturnType<typeof setInterval>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  messageHeartbeats: number;
}

/** 本地时间 HH:MM:SS，用于汇总帧首行的时间戳 */
function nowStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 工具计数：`[n] 🔧 name`（行组帧外层再加一次 [HH:MM:SS] 时间戳） */
function formatToolCount(name: string, count: number): string {
  return `[${count}] 🔧 ${name}`;
}

/** 心跳文案：仅工具名×总次数与时长，无参数无响应（features.md 决策 #3） */
export function formatHeartbeat(elapsedMs: number, tools: Map<string, ToolStat2>): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  const elapsedText = minutes < 1 ? "不到 1 分钟" : `${minutes} 分钟`;
  if (tools.size === 0) return `⏱ 已运行 ${elapsedText}（尚未产生工具调用）`;
  const parts = [...tools.entries()].map(([name, s]) => formatToolCount(name, s.count));
  const errors = [...tools.values()].reduce((n, s) => n + s.errors, 0);
  const suffix = errors > 0 ? ` · ${errors} 失败` : "";
  return `⏱ 已运行 ${elapsedText} · ${parts.join(" · ")}${suffix}`;
}

const STREAM_LIVENESS_MS = 60_000; // 空窗口静默超过该时长时补活性心跳行
const TYPING_INTERVAL_MS = 50_000; // 平台 typing 窗口 ~60s，提前续期
const PENDING_TTL_MS = 15_000; // QQ 触发标记的有效期（超过视为本地 run）

export class RunFeedback {
  private readonly deps: RunFeedbackDeps;
  private pending: { openid: string; msgId: string; at: number } | null = null;
  private run: RunState | null = null;
  private flushQueue: Promise<boolean> = Promise.resolve(true);

  constructor(deps: RunFeedbackDeps) {
    this.deps = deps;
  }

  /** inbound 在注入 pi 前调用：标记接下来的 run 由 QQ 触发 */
  markQQTrigger(openid: string, msgId: string): void {
    this.pending = { openid, msgId, at: Date.now() };
  }

  /** 当前 run 是否由 QQ 触发（用量摘要只对 QQ 会话发送） */
  isQQTriggeredRun(): boolean {
    return this.run !== null;
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
      winThinking: false,
      thinkingMarked: false,
      winTools: new Map(),
      snapshotText: "",
      finalizedText: "",
      resultSentLen: 0,
      startNewBubble: false,
      cur: null,
      lastAppendAt: Date.now(),
      messageHeartbeats: 0,
    };
    this.run = run;

    // typing 保鲜：run 开始立即亮起"正在输入"，之后每 50s 续期（0 额度）
    const keepTyping = () => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    };
    keepTyping();
    run.typingTimer = setInterval(keepTyping, TYPING_INTERVAL_MS);

    // 固定频率汇总帧（间隔可配，毫秒）
    run.flushTimer = setInterval(() => {
      void this.flushWindow(run);
    }, Math.max(this.deps.getStreamFlushMs(), 300));

    // 心跳兜底（流式路径的活性由空窗口活性行覆盖）
    if (hbMinutes > 0) {
      run.heartbeatTimer = setInterval(() => {
        void this.beat();
      }, hbMinutes * 60_000);
    }
  }

  /** 工具开始：窗口计数 +1（汇总帧里以 `[n] 🔧 name` 呈现；不立即外发，避免与汇总帧双份） */
  onToolStart(toolName: string): void {
    const run = this.run;
    if (!run) return;
    run.winTools.set(toolName, (run.winTools.get(toolName) ?? 0) + 1);
  }

  /** 工具结束：总计计数（心跳 ⏱ 行用） */
  onToolEnd(toolName: string, isError: boolean): void {
    const run = this.run;
    if (!run) return;
    const stat = run.tools.get(toolName) ?? { count: 0, errors: 0 };
    stat.count += 1;
    if (isError) stat.errors += 1;
    run.tools.set(toolName, stat);
  }

  /** assistant 流式快照（message_update）：只更新窗口，汇总帧统一发送 */
  async onAssistantDelta(snapshotText: string, snapshotThinking: string): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (snapshotThinking && !run.thinkingMarked) {
      run.thinkingMarked = true;
      run.winThinking = true;
    }
    run.snapshotText = snapshotText;
  }

  /**
   * assistant 消息定稿（message_end）。
   * 返回 true 表示流接管（调用方跳过 sendReply）；默认/流失败返回 false 走消息路径。
   */
  async onAssistantFinal(text: string, isError: boolean): Promise<boolean> {
    const run = this.run;
    if (!run) return false;

    if (isError) {
      // 出错也先封口当前气泡（结束 QQ 的生成态），错误摘要交回调用方走消息链路
      await this.closeBubble(run);
      return false;
    }

    run.finalizedText = [run.finalizedText, text].filter((s) => s.trim()).join("\n\n");
    run.snapshotText = "";
    run.thinkingMarked = false; // 下一条 assistant 消息重新计时思考标记
    if (!this.deps.getStreamRelay()) return false;

    // 先把本条消息剩余的快照补发完，再把边界标记留给下一条文本消息
    // （若在 flush 前置位，本条消息的残余增量会被误判为新消息而切泡）
    const handled = await this.flushWindow(run);
    run.startNewBubble = true;
    return handled;
  }

  /** 封口当前气泡：补发剩余窗口 + DONE。flush 可能因切泡换掉 cur，需重新读取。 */
  private async sealBubble(run: RunState): Promise<void> {
    await this.flushWindow(run);
    await this.closeBubble(run);
  }

  /** 关闭当前气泡并发送 DONE；DONE 失败也视为已关闭（追加模式无撤销语义）。 */
  private async closeBubble(run: RunState): Promise<void> {
    const cur = run.cur;
    if (!cur) return;
    run.cur = null;
    try {
      await cur.stream.done();
    } catch {}
  }

  /** run 结束：封口最后一个气泡（补帧 + DONE），清定时器 */
  async onAgentEnd(): Promise<void> {
    const run = this.run;
    this.clearTimers();
    this.run = null;
    if (run) {
      // DONE 失败不补发——内容已随汇总帧展示（避免双发）
      try {
        await this.sealBubble(run);
      } catch {}
    }
  }

  /** session_shutdown 等异常路径的清理 */
  dispose(): void {
    this.clearTimers();
    this.run?.cur?.stream.dispose();
    this.run = null; // 未发 DONE 的气泡会停留在生成态（追加模式无撤销语义，可接受）
  }

  private clearTimers(): void {
    const run = this.run;
    if (!run) return;
    if (run.typingTimer) clearInterval(run.typingTimer);
    if (run.flushTimer) clearInterval(run.flushTimer);
    if (run.heartbeatTimer) clearInterval(run.heartbeatTimer);
    run.typingTimer = undefined;
    run.flushTimer = undefined;
    run.heartbeatTimer = undefined;
  }

  /**
   * 把窗口增量写入对应气泡：思考/工具行组进活动气泡，文本进文本气泡。
   * 文本消息首个增量或行组到达时切换气泡；同一消息的后续增量不切泡。
   * 通过 promise 链串行化：限流重试期间（最长 7s）定时器再次触发也不会产生交错帧。
   */
  flushWindow(run?: RunState): Promise<boolean> {
    const p = this.flushQueue.then(() => this.doFlushWindow(run));
    this.flushQueue = p.catch(() => false);
    return p;
  }

  private async doFlushWindow(run?: RunState): Promise<boolean> {
    const r = run ?? this.run;
    if (!r) return false;
    if (!this.deps.getStreamRelay()) return false;

    const full = [r.finalizedText, r.snapshotText].filter((s) => s.trim()).join("\n\n");
    const textDelta = full.slice(r.resultSentLen);
    const textVisible = textDelta.trim().length > 0;

    // 行组（思考/工具计数）——无文本的窗口也照常汇总
    const okLines = await this.appendLineGroups(r);
    if (!okLines) return false;

    // 文本消息独立成泡（空白增量只推进基准，不追加）
    if (textVisible) {
      const okText = await this.appendText(r, textDelta);
      if (!okText) return false;
      // 关键：推进已发送基准，否则下一帧会把同一段全文再追加一次
      r.resultSentLen = full.length;
      r.startNewBubble = false;
    } else if (textDelta) {
      r.resultSentLen = full.length;
    }

    // 重置窗口
    r.winThinking = false;
    r.winTools.clear();
    return true;
  }

  /** 收集本窗口的思考/工具行组（无行返回空串） */
  private collectWindowLines(r: RunState): string[] {
    const lines: string[] = [];
    if (r.winThinking) lines.push("💭 思考中...");
    for (const [name, n] of r.winTools) {
      if (n > 0) lines.push(formatToolCount(name, n));
    }
    return lines;
  }

  /** 追加行组：只进活动气泡；首行带时间戳；行与行相邻不空行，跨帧直接续行 */
  private async appendLineGroups(r: RunState, lines?: string[]): Promise<boolean> {
    const group = lines ?? this.collectWindowLines(r);
    if (group.length === 0) return true;
    const stamp = `[${nowStamp()}] `;
    const frame = stamp + group.join(`\n${stamp}`) + "\n";
    return this.pushAppend(r, frame, "activity");
  }

  /** 追加文本：文本消息独占气泡，同一消息续写直接拼接；诊断模式带内联时间戳 */
  private async appendText(r: RunState, text: string): Promise<boolean> {
    // 上一条文本消息已定稿 → 封口旧文本气泡，本条消息另起一泡
    if (r.startNewBubble) await this.closeBubble(r);
    const stamp = this.deps.getDebug() ? `[${nowStamp()}] ` : "";
    return this.pushAppend(r, stamp + text, "text");
  }

  /** 心跳兜底：流式路径的活性由空窗口活性行覆盖；流不可用时发消息心跳（保险丝 ≤N 条） */
  private async beat(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (this.deps.getStreamRelay()) return;

    if (run.messageHeartbeats >= this.deps.getHeartbeatMaxMessages()) return;
    const bound = this.deps.boundOpenid();
    if (!bound) return;
    const bot = this.deps.bot();
    if (!bot) return;
    run.messageHeartbeats += 1;
    await sendReply(
      bot,
      `[${nowStamp()}] ${formatHeartbeat(Date.now() - run.startedAt, run.tools)}`,
      this.deps.makeChannel(),
    );
  }

  /** 追加一帧（惰性建气泡；内容类型变化时先封口旧气泡）；失败弃气泡并返回 false */
  private async pushAppend(run: RunState, delta: string, kind: "activity" | "text"): Promise<boolean> {
    if (!delta) return true;
    const bot = this.deps.bot();
    if (!bot) return false;
    try {
      if (run.cur && run.cur.kind !== kind) {
        await this.closeBubble(run);
      }
      if (!run.cur) {
        if (!run.msgId) return false;
        run.cur = {
          stream: new AppendStream(bot.messageApi, bot.getCredentials(), run.openid, run.msgId, {
            onError: (err) => this.handleStreamError(run, err),
          }),
          kind,
        };
      }
      await run.cur.stream.append(delta);
      run.lastAppendAt = Date.now();
      return true;
    } catch (err) {
      this.handleStreamError(run, err as Error);
      return false;
    }
  }

  /** 流不可信：丢弃当前气泡，并把尚未追加到流的结果文本用消息路径补发（避免结果丢失） */
  private handleStreamError(run: RunState, err: Error): void {
    const had = run.cur !== null;
    run.cur = null;
    if (had) this.deps.onWarn(`流式通道不可用，本回合已降级（${err.message}）`);
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
