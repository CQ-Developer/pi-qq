import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream } from "./append-stream";
import { sendReply, type ReplyChannel } from "./outbound";
import type { ReplyBudget } from "./reply-budget";

/**
 * F7 长任务反馈：run 级状态机（固定频率汇总帧版）。
 *
 * 场景：user_input → thinking+tools（10~60 分钟）→ assistant message，n 轮循环。
 * 流式气泡 = 汇总时间线：每 STREAM_FLUSH_MS 把窗口内的增量合成一帧追加
 * （思考状态 → 工具计数 → 消息文本增量），帧间按内容类型补换行/空行：
 *
 *   思考中...
 *   bash * 3
 *   read * 2
 *
 *   中间消息原文
 *   edit * 1
 *
 *   最终回复原文
 *
 * 任何一帧失败即标 dead：未发出的结果文本自动转消息路径补发；
 * streamRelay 关闭时整条时间线不可用，assistant 消息走普通消息路径（M2 行为）。
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
  getStreamRelay: () => boolean;
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
  /** 已追加到流的结果文本长度（增量计算基准） */
  resultSentLen: number;
  /** 流中已有内容 */
  streamHasContent: boolean;
  /** 最后追加的帧类型（决定换行/空行） */
  lastKind: "none" | "text" | "line";
  stream: AppendStream | null;
  streamState: "unopened" | "open" | "dead";
  typingTimer?: ReturnType<typeof setInterval>;
  flushTimer?: ReturnType<typeof setInterval>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  messageHeartbeats: number;
}

/** 心跳文案：仅工具名×总次数与时长，无参数无响应（features.md 决策 #3） */
export function formatHeartbeat(elapsedMs: number, tools: Map<string, ToolStat>): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  const elapsedText = minutes < 1 ? "不到 1 分钟" : `${minutes} 分钟`;
  if (tools.size === 0) return `⏱ 已运行 ${elapsedText}（尚未产生工具调用）`;
  const parts = [...tools.entries()].map(([name, s]) => `${name}×${s.count}`);
  const errors = [...tools.values()].reduce((n, s) => n + s.errors, 0);
  const suffix = errors > 0 ? ` · ${errors} 失败` : "";
  return `⏱ 已运行 ${elapsedText} · ${parts.join(" · ")}${suffix}`;
}

const STREAM_FLUSH_MS = 3000; // 汇总帧固定频率
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
      streamHasContent: false,
      lastKind: "none",
      stream: null,
      streamState: "unopened",
      messageHeartbeats: 0,
    };
    this.run = run;

    // typing 保鲜：run 期间持续"正在输入"，0 额度
    run.typingTimer = setInterval(() => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    }, TYPING_INTERVAL_MS);

    // 固定频率汇总帧
    run.flushTimer = setInterval(() => {
      void this.flushWindow();
    }, STREAM_FLUSH_MS);

    // 节流心跳
    if (hbMinutes > 0) {
      run.heartbeatTimer = setInterval(() => {
        void this.beat();
      }, hbMinutes * 60_000);
    }
  }

  /** 工具开始：窗口计数 +1（汇总帧里以 `name * n` 呈现） */
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
      run.streamState = "dead";
      run.stream = null;
      return false;
    }

    run.finalizedText = [run.finalizedText, text].filter((s) => s.trim()).join("\n\n");
    run.snapshotText = "";
    run.thinkingMarked = false; // 下一条 assistant 消息重新计时思考标记
    if (!this.deps.getStreamRelay() || run.streamState === "dead") return false;

    return await this.flushWindow();
  }

  /** run 结束：发剩余汇总帧 + DONE，清定时器 */
  async onAgentEnd(): Promise<void> {
    const run = this.run;
    this.clearTimers();
    this.run = null;
    if (run?.stream && run.streamState === "open") {
      try {
        await this.flushWindow(run);
        await run.stream.done();
      } catch {
        // DONE 失败不补发——内容已随汇总帧展示（避免双发）
      }
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
    if (run.flushTimer) clearInterval(run.flushTimer);
    if (run.heartbeatTimer) clearInterval(run.heartbeatTimer);
    run.typingTimer = undefined;
    run.flushTimer = undefined;
    run.heartbeatTimer = undefined;
  }

  /**
   * 把窗口增量合成一帧：思考行 → 工具计数行 → （空行）→ 文本增量。
   * 帧内/帧间的换行与空行由 lastKind 推导，匹配设计稿的分组排版。
   */
  private async flushWindow(run?: RunState): Promise<boolean> {
    const r = run ?? this.run;
    if (!r || r.streamState === "dead") return false;
    if (!this.deps.getStreamRelay()) return false;

    const full = [r.finalizedText, r.snapshotText].filter((s) => s.trim()).join("\n\n");
    const textDelta = full.slice(r.resultSentLen);

    let frame = "";
    if (r.winThinking) frame += this.prefixLine(r) + "思考中...\n";
    for (const [name, n] of r.winTools) {
      if (n > 0) frame += this.prefixLine(r) + `${name} * ${n}\n`;
    }
    if (textDelta) frame += this.prefixText(r) + textDelta;

    if (!frame) return true; // 窗口无增量
    if (!(await this.pushAppend(r, frame, textDelta ? "text" : "line"))) return false;

    // 重置窗口
    r.winThinking = false;
    r.winTools.clear();
    return true;
  }

  /** 行类前缀：文本未收行时补换行；行与行相邻不加空行 */
  private prefixLine(run: RunState): string {
    if (!run.streamHasContent) return "";
    return run.lastKind === "text" ? "\n" : "";
  }

  /** 文本块前缀：行/块之后空一行分组；文本续写直接拼接 */
  private prefixText(run: RunState): string {
    if (!run.streamHasContent) return "";
    return run.lastKind === "text" ? "" : "\n";
  }

  /** 心跳：streamRelay 开启时作为汇总行追加进流，降级消息心跳（保险丝 ≤N 条） */
  private async beat(): Promise<void> {
    const run = this.run;
    if (!run) return;
    const line = formatHeartbeat(Date.now() - run.startedAt, run.tools);
    if (this.deps.getStreamRelay() && run.streamState !== "dead" && (await this.pushAppend(run, this.prefixLine(run) + `${line}\n`, "line"))) {
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
  private async pushAppend(run: RunState, delta: string, kind: "line" | "text"): Promise<boolean> {
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
      run.streamHasContent = true;
      run.lastKind = kind;
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
