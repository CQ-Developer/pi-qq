import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream } from "./append-stream";
import { sendReply, type ReplyChannel } from "./outbound";
import type { ReplyBudget } from "./reply-budget";
import { log } from "./logger";

/**
 * F7 long-task feedback: run-level state machine (summary frames + text bubbles).
 *
 * Scenario: user_input → thinking/tools (10–60 minutes) → assistant message, n turns.
 *
 * Bubble rules: **assistant text and thinking/tool summaries use separate bubbles.**
 * Each text message (streaming increments of one assistant message) owns a text
 * bubble; thinking/tool line groups go to an activity bubble. The first text delta
 * closes the current activity bubble; a line group closes the current text bubble.
 * The final reply is its own text bubble. Frames are sent every `streamFlushMs`
 * (default 10000ms):
 *
 *   Activity: [💭] Thinking... / [🔧] [2] bash (event order)
 *   Text: message text (streamed increments, rendered as Markdown)
 *
 * Any failed frame discards the bubble; unsent text falls back to the message path.
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
  /** Stream summary frame interval in ms (minimum 300). */
  getStreamFlushMs: () => number;
  getStreamRelay: () => boolean;
  makeChannel: () => ReplyChannel;
  onWarn: (msg: string) => void;
}

interface ToolStat2 {
  count: number;
  errors: number;
}

/** Current bubble: one stream message; kind selects text or activity rows. */
interface Bubble {
  stream: AppendStream;
  kind: "activity" | "text";
}

type WindowLine = { kind: "thinking" } | { kind: "tool"; name: string; count: number };

interface RunState {
  startedAt: number;
  openid: string;
  msgId?: string;
  /** Total tool counts (for the heartbeat line). */
  tools: Map<string, ToolStat2>;
  /** Line groups in this window, in event order (cleared after flush). */
  winLines: WindowLine[];
  /** Thinking marker for the current message (reset per message). */
  thinkingMarked: boolean;
  /** Current streaming text snapshot (updated by message_update). */
  snapshotText: string;
  /** Accumulated finalized assistant text. */
  finalizedText: string;
  /** Length of result text already sent (delta baseline across bubbles). */
  resultSentLen: number;
  /** Previous text message finalized: close the current text bubble on the next text delta. */
  startNewBubble: boolean;
  /** Current bubble (null = create lazily). */
  cur: Bubble | null;
  /** Timestamp of the last successful append (for liveness). */
  lastAppendAt: number;
  typingTimer?: ReturnType<typeof setInterval>;
  flushTimer?: ReturnType<typeof setInterval>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  messageHeartbeats: number;
}

/** Tool count line: `[🔧] [n] name`. */
function formatToolCount(name: string, count: number): string {
  return `[🔧] [${count}] ${name}`;
}

/** Heartbeat text: tool totals and elapsed time only (features-v1.md decision #3). */
export function formatHeartbeat(elapsedMs: number, tools: Map<string, ToolStat2>): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  const elapsedText = minutes < 1 ? "less than 1 minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (tools.size === 0) return `⏱ Running for ${elapsedText} (no tool calls yet)`;
  const parts = [...tools.entries()].map(([name, s]) => formatToolCount(name, s.count));
  const errors = [...tools.values()].reduce((n, s) => n + s.errors, 0);
  const suffix = errors > 0 ? ` · ${errors} failed` : "";
  return `⏱ Running for ${elapsedText} · ${parts.join(" · ")}${suffix}`;
}

const TYPING_INTERVAL_MS = 50_000; // Platform typing window ~60s; renew early
const PENDING_TTL_MS = 15_000; // QQ trigger TTL (older means a local run)

export class RunFeedback {
  private readonly deps: RunFeedbackDeps;
  private pending: { openid: string; msgId: string; at: number } | null = null;
  private run: RunState | null = null;
  private flushQueue: Promise<boolean> = Promise.resolve(true);

  constructor(deps: RunFeedbackDeps) {
    this.deps = deps;
  }

  /** Called by inbound before injecting: mark the next run as QQ-triggered. */
  markQQTrigger(openid: string, msgId: string): void {
    this.pending = { openid, msgId, at: Date.now() };
  }

  /** Whether a QQ-triggered run is active. Local pi runs have no RunFeedback state. */
  isQQRunActive(): boolean {
    return this.run !== null;
  }

  onAgentStart(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return; // Not QQ-triggered
    const bot = this.deps.bot();
    if (!bot) return;

    const hbMinutes = this.deps.getHeartbeatMinutes();
    const run: RunState = {
      startedAt: Date.now(),
      openid: pending.openid,
      msgId: pending.msgId,
      tools: new Map(),
      winLines: [],
      thinkingMarked: false,
      snapshotText: "",
      finalizedText: "",
      resultSentLen: 0,
      startNewBubble: false,
      cur: null,
      lastAppendAt: Date.now(),
      messageHeartbeats: 0,
    };
    this.run = run;
    log.debug("run", "started", { msgId: run.msgId?.slice(0, 8) ?? "?" });

    // Typing keepalive: start immediately, renew every 50s (zero quota).
    const keepTyping = () => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    };
    keepTyping();
    run.typingTimer = setInterval(keepTyping, TYPING_INTERVAL_MS);

    // Fixed-interval summary frames (configurable in ms).
    run.flushTimer = setInterval(
      () => {
        void this.flushWindow(run);
      },
      Math.max(this.deps.getStreamFlushMs(), 300),
    );

    // Heartbeat fallback (liveness is covered by empty-window rows).
    if (hbMinutes > 0) {
      run.heartbeatTimer = setInterval(() => {
        void this.beat();
      }, hbMinutes * 60_000);
    }
  }

  /** Tool start: record in event order; merge consecutive same-tool calls. */
  onToolStart(toolName: string): void {
    const run = this.run;
    if (!run) return;
    const last = run.winLines.at(-1);
    if (last?.kind === "tool" && last.name === toolName) {
      last.count += 1;
    } else {
      run.winLines.push({ kind: "tool", name: toolName, count: 1 });
    }
  }

  /** Tool end: update totals for the heartbeat line. */
  onToolEnd(toolName: string, isError: boolean): void {
    const run = this.run;
    if (!run) return;
    const stat = run.tools.get(toolName) ?? { count: 0, errors: 0 };
    stat.count += 1;
    if (isError) stat.errors += 1;
    run.tools.set(toolName, stat);
  }

  /** Assistant snapshot: update the window; frames are sent by flush. */
  async onAssistantDelta(snapshotText: string, snapshotThinking: string): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (snapshotThinking && !run.thinkingMarked) {
      run.thinkingMarked = true;
      run.winLines.push({ kind: "thinking" });
    }
    run.snapshotText = snapshotText;
  }

  /**
   * Finalize an assistant message (message_end).
   * Returns true when the stream took over (caller skips sendReply); false falls
   * back to the message path.
   */
  async onAssistantFinal(text: string, isError: boolean): Promise<boolean> {
    const run = this.run;
    if (!run) return false;

    if (isError) {
      // Seal the current bubble even on error; the caller sends the error message.
      await this.closeBubble(run);
      return false;
    }

    run.finalizedText = [run.finalizedText, text].filter((s) => s.trim()).join("\n\n");
    run.snapshotText = "";
    run.thinkingMarked = false; // Reset the thinking marker for the next message
    if (!this.deps.getStreamRelay()) return false;

    // Flush remaining text first, then set the boundary for the next text message.
    // Setting it earlier would misclassify leftover deltas as a new message.
    const handled = await this.flushWindow(run);
    run.startNewBubble = true;
    return handled;
  }

  /** Seal the current bubble: flush the window + DONE; re-read cur after flush. */
  private async sealBubble(run: RunState): Promise<void> {
    await this.flushWindow(run);
    await this.closeBubble(run);
  }

  /** Close the current bubble and send DONE; DONE failure still counts as closed. */
  private async closeBubble(run: RunState): Promise<void> {
    const cur = run.cur;
    if (!cur) return;
    run.cur = null;
    try {
      await cur.stream.done();
    } catch {}
  }

  /** Run end: seal the last bubble (flush + DONE) and clear timers. */
  async onAgentEnd(): Promise<void> {
    const run = this.run;
    this.clearTimers();
    this.run = null;
    if (run) {
      log.debug("run", "ended", {
        msgId: run.msgId?.slice(0, 8) ?? "?",
        elapsedMs: Date.now() - run.startedAt,
      });
      // Do not resend on DONE failure; content was already shown.
      try {
        await this.sealBubble(run);
      } catch {}
    }
  }

  /** Cleanup for session_shutdown and other error paths. */
  dispose(): void {
    this.clearTimers();
    this.run?.cur?.stream.dispose();
    this.run = null; // A bubble without DONE may stay generating (append mode cannot undo).
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
   * Write window increments to bubbles: activity rows to activity bubbles, text
   * to text bubbles. A new text message or line group switches bubbles; later
   * deltas of the same message do not. A promise chain serializes flushes so
   * retries cannot interleave frames.
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

    // Line groups (thinking/tool counts) are summarized even without text.
    const okLines = await this.appendLineGroups(r);
    if (!okLines) return false;

    // Text gets its own bubble (whitespace-only deltas only advance the baseline).
    if (textVisible) {
      const okText = await this.appendText(r, textDelta);
      if (!okText) return false;
      // Advance the sent baseline or the next frame will append the same text again.
      r.resultSentLen = full.length;
      r.startNewBubble = false;
    } else if (textDelta) {
      r.resultSentLen = full.length;
    }

    // Reset the window
    r.winLines = [];
    return true;
  }

  /** Collect window rows in event order (consecutive same tools merged). */
  private collectWindowLines(r: RunState): string[] {
    return r.winLines.map((line) =>
      line.kind === "thinking" ? "[💭] Thinking..." : formatToolCount(line.name, line.count),
    );
  }

  /** Append activity rows; rows continue across frames. */
  private async appendLineGroups(r: RunState, lines?: string[]): Promise<boolean> {
    const group = lines ?? this.collectWindowLines(r);
    if (group.length === 0) return true;
    return this.pushAppend(r, `${group.join("\n")}\n`, "activity");
  }

  /** Append text: text messages own bubbles. */
  private async appendText(r: RunState, text: string): Promise<boolean> {
    // Previous text message finalized: seal it and start a new bubble.
    if (r.startNewBubble) await this.closeBubble(r);
    return this.pushAppend(r, text, "text");
  }

  /** Heartbeat fallback when streaming is unavailable (max N messages per run). */
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
    await sendReply(bot, formatHeartbeat(Date.now() - run.startedAt, run.tools), this.deps.makeChannel());
  }

  /** Append a frame (lazy bubble; close on kind change); discard on failure. */
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
            onDebug: (message) => log.debug("stream", message, { msgId: run.msgId?.slice(0, 8) ?? "?" }),
          }),
          kind,
        };
        this.deps.budget.noteStreamBubble(run.msgId);
      }
      await run.cur.stream.append(delta);
      run.lastAppendAt = Date.now();
      return true;
    } catch (err) {
      this.handleStreamError(run, err as Error);
      return false;
    }
  }

  /** Stream is untrusted: discard the bubble and resend unsent text via messages. */
  private handleStreamError(run: RunState, err: Error): void {
    const had = run.cur !== null;
    run.cur = null;
    log.warn("stream", "stream error", {
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
      err,
    });
    if (had) this.deps.onWarn(`Stream unavailable; falling back to text (${err.message}).`);
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
