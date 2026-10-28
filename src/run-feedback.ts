import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream } from "./append-stream";
import { sendReply, type ReplyChannel } from "./outbound";
import type { ReplyBudget } from "./reply-budget";

/**
 * F7 长任务反馈：run 级状态机（固定频率汇总帧版）。
 *
 * 场景：user_input → thinking+tools（10~60 分钟）→ assistant message，n 轮循环。
 * 流式气泡 = 回合活动时间线，**每回合一个独立气泡**：
 * 回合（message_start）开始时封口上一气泡（补帧 + DONE），新气泡累计本回合的
 * 思考标记 / 工具计数 / 消息文本增量，按 STREAM_FLUSH_MS 固定频率合帧追加：
 *
 *   气泡1：💭 思考中... / 🔧 bash * 3 / 🔧 read * 2 / 消息1原文
 *   气泡2：🔧 write * 1 / 💭 思考中... / 🔧 bash * 2 / 消息2原文
 *   气泡3：最终回复原文
 *
 * 任何一帧失败即标 dead：未发出的结果文本自动转消息路径补发；
 * streamRelay 关闭时整条时间线不可用，assistant 消息走普通消息路径（M2 行为）。
 */

export interface ToolStat {
  count: number;
  errors: number;
}

/** 当前回合气泡：一条独立流式消息 + 其排版状态 */
interface TurnStream {
  stream: AppendStream;
  /** 气泡中已有内容 */
  hasContent: boolean;
  /** 最后追加的帧类型（决定换行/空行） */
  lastKind: "none" | "text" | "line";
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

interface RunState {
  startedAt: number;
  openid: string;
  msgId?: string;
  /** 工具总计（心跳 ⏱ 行用） */
  tools: Map<string, ToolStat>;
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
  /** 当前回合气泡（null = 待惰性创建） */
  cur: TurnStream | null;
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

/** 心跳文案：仅工具名×总次数与时长，无参数无响应（features.md 决策 #3） */
export function formatHeartbeat(elapsedMs: number, tools: Map<string, ToolStat>): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  const elapsedText = minutes < 1 ? "不到 1 分钟" : `${minutes} 分钟`;
  if (tools.size === 0) return `⏱ 已运行 ${elapsedText}（尚未产生工具调用）`;
  const parts = [...tools.entries()].map(([name, s]) => `🔧 ${name} * ${s.count}`);
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
      winThinking: false,
      thinkingMarked: false,
      winTools: new Map(),
      snapshotText: "",
      finalizedText: "",
      resultSentLen: 0,
      cur: null,
      lastAppendAt: Date.now(),
      messageHeartbeats: 0,
    };
    this.run = run;

    // typing 保鲜：run 期间持续"正在输入"，0 额度
    run.typingTimer = setInterval(() => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    }, TYPING_INTERVAL_MS);

    // 固定频率汇总帧（间隔可配，毫秒）
    run.flushTimer = setInterval(() => {
      void this.flushWindow();
    }, Math.max(this.deps.getStreamFlushMs(), 300));

    // 节流心跳
    if (hbMinutes > 0) {
      run.heartbeatTimer = setInterval(() => {
        void this.beat();
      }, hbMinutes * 60_000);
    }
  }

  /** 工具调用开始：窗口计数 +1，时间线追加一行“🔧 工具名”（无参数） */
  async onToolStart(toolName: string): Promise<void> {
    const run = this.run;
    if (!run) return;
    run.winTools.set(toolName, (run.winTools.get(toolName) ?? 0) + 1);
    if (!this.deps.getStreamRelay()) return;
    await this.pushAppend(run, `🔧 ${toolName}\n`, "line");
  }

  /** 回合开始（message_start, assistant）：封口上一气泡，本回合内容进新气泡 */
  async onTurnStart(): Promise<void> {
    const run = this.run;
    if (!run) return;
    await this.sealTurn(run);
  }

  /** 封口当前气泡：补发剩余窗口 + DONE，之后内容进新气泡 */
  private async sealTurn(run: RunState): Promise<void> {
    const cur = run.cur;
    if (!cur) return;
    await this.flushWindow(run);
    try {
      await cur.stream.done();
    } catch {}
    run.cur = null;
  }

  onToolEnd(toolName: string, isError: boolean): void {
    const run = this.run;
    if (!run) return;
    const stat = run.tools.get(toolName) ?? { count: 0, errors: 0 };
    stat.count += 1;
    if (isError) stat.errors += 1;
    run.tools.set(toolName, stat);
  }

  /** assistant 流式快照（message_update）：只更新窗口，3s 汇总帧统一发送 */
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
      // 出错即弃流，错误摘要交回调用方走预算链路
      run.cur = null;
      return false;
    }

    run.finalizedText = [run.finalizedText, text].filter((s) => s.trim()).join("\n\n");
    run.snapshotText = "";
    run.thinkingMarked = false; // 下一条 assistant 消息重新计时思考标记
    if (!this.deps.getStreamRelay()) return false;

    return await this.flushWindow(run);
  }

  /** run 结束：发剩余汇总帧 + DONE，清定时器 */
  async onAgentEnd(): Promise<void> {
    const run = this.run;
    this.clearTimers();
    this.run = null;
    if (run?.cur) {
      try {
        await this.sealTurn(run);
      } catch {
        // DONE 失败不补发——内容已随汇总帧展示（避免双发）
      }
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
   * 把窗口增量合成一帧，顺序与真实时序一致：思考行 → 消息文本增量 → 工具计数行。
   * 规则（用户确认）：消息文本发完之后才发送工具汇总；帧内/帧间的换行与空行由 lastKind 推导。
   * 通过 promise 链串行化：限流重试期间（最长 7s）定时器再次触发也不会产生交错帧。
   */
  private flushQueue: Promise<boolean> = Promise.resolve(true);

  flushWindow(run?: RunState): Promise<boolean> {
    const p = this.flushQueue.then(() => this.doFlushWindow(run));
    this.flushQueue = p.catch(() => false);
    return p;
  }

  private async doFlushWindow(run?: RunState): Promise<boolean> {
    const r = run ?? this.run;
    if (!r || !r.cur) return true; // 本回合气泡尚未创建，无内容可补
    if (!this.deps.getStreamRelay()) return false;

    const full = [r.finalizedText, r.snapshotText].filter((s) => s.trim()).join("\n\n");
    const textDelta = full.slice(r.resultSentLen);

    let kind = r.cur.lastKind;
    let frame = "";
    // ① 思考行（惰性：本消息出现 thinking 才有），首行带时间戳便于核对推送节奏
    if (r.winThinking) {
      frame += (kind === "text" ? "\n" : "") + `[${nowStamp()}] 💭 思考中...\n`;
      kind = "line";
    }
    // ② 消息文本增量（先发完文本——工具总在 message_end 后执行，此时文本必然已定稿）
    if (textDelta) {
      // 诊断模式：文本增量也带时间戳（内联，便于核对全部帧的推送节奏）
      const stamp = this.deps.getDebug() ? `[${nowStamp()}] ` : "";
      frame += (kind === "line" ? "\n" : "") + `${stamp}${textDelta}`;
      kind = "text";
    }
    // ③ 工具计数行（文本之后），首行带时间戳
    let firstLine = true;
    for (const [name, n] of r.winTools) {
      if (n > 0) {
        const stamp = kind === "text" || (kind === "line" && firstLine) ? `[${nowStamp()}] ` : "";
        frame += (kind === "text" ? "\n" : "") + `${stamp}🔧 ${name} * ${n}\n`;
        kind = "line";
        firstLine = false;
      }
    }

    if (!frame) {
      // 空窗口：静默超过 STREAM_LIVENESS_MS 时补一条活性心跳行（长思考/长工具不再无推送）
      if (Date.now() - r.lastAppendAt >= STREAM_LIVENESS_MS) {
        const line = `[${nowStamp()}] ${formatHeartbeat(Date.now() - r.startedAt, r.tools)}`;
        if (await this.pushAppend(r, (r.cur.lastKind === "text" ? "\n" : "") + `${line}\n`, "line")) {
          r.lastAppendAt = Date.now();
        }
      }
      return true;
    }
    if (!(await this.pushAppend(r, frame, kind === "text" ? "text" : "line"))) return false;

    // 重置窗口，并推进结果文本增量基准（关键：否则每次 flush 都会重发全部文本）
    r.winThinking = false;
    r.winTools.clear();
    r.resultSentLen = full.length;
    return true;
  }

  /** 行类前缀：文本未收行时补换行；行与行相邻不加空行 */
  private prefixLine(run: RunState): string {
    if (!run.cur) return "";
    return run.cur.lastKind === "text" ? "\n" : "";
  }

  /** 文本块前缀：行/块之后空一行分组；文本续写直接拼接 */
  private prefixText(run: RunState): string {
    if (!run.cur) return "";
    return run.cur.lastKind === "text" ? "" : "\n";
  }

  /** 心跳兜底：流式路径的活性已由空窗口活性行（3s flush 内）覆盖；流不可用时发消息心跳（保险丝 ≤N 条） */
  private async beat(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (this.deps.getStreamRelay()) return; // 活性由 3s flush 的空窗口活性行覆盖

    // 流不可用 → 消息心跳（保险丝）
    if (run.messageHeartbeats >= this.deps.getHeartbeatMaxMessages()) return;
    const bound = this.deps.boundOpenid();
    if (!bound) return;
    const bot = this.deps.bot();
    if (!bot) return;
    run.messageHeartbeats += 1;
    await sendReply(bot, `[${nowStamp()}] ${formatHeartbeat(Date.now() - run.startedAt, run.tools)}`, this.deps.makeChannel());
  }

  /** 追加一帧（惰性建流）；失败标 dead 并返回 false */
  private async pushAppend(run: RunState, delta: string, kind: "line" | "text"): Promise<boolean> {
    if (!delta) return true;
    const bot = this.deps.bot();
    if (!bot) return false;
    try {
      if (!run.cur) {
        if (!run.msgId) return false;
        run.cur = {
          stream: new AppendStream(bot.messageApi, bot.getCredentials(), run.openid, run.msgId, {
            onError: (err) => this.handleStreamError(run, err),
          }),
          hasContent: false,
          lastKind: "none",
        };
      }
      await run.cur.stream.append(delta);
      run.cur.hasContent = true;
      run.cur.lastKind = kind;
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
