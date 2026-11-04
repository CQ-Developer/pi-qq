import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { BubbleWriter } from "./bubble-writer";
import type { ReplyBudget } from "../quota/reply-quota";
import { log } from "../infra/file-logger";

export interface RunFeedbackDeps {
  bot: () => QQBot | undefined;
  budget: ReplyBudget;
  getThinkingRelay: () => boolean;
  onWarn: (msg: string) => void;
}

interface ToolCall {
  id: string;
  name: string;
  args?: unknown;
  result?: { isError: boolean; result?: unknown };
  started: boolean;
  finished: boolean;
}

interface RunState {
  startedAt: number;
  openid: string;
  msgId?: string;
  thinkingSentLen: number;
  finalizedText: string;
  /** Latest text of the current run, kept for the QQ /last command. */
  currentText: string;
  resultSentLen: number;
  tools: ToolCall[];
  activeTool?: string;
  deferredThinking: string;
  deferredText: string;
  hadError: boolean;
  writer: BubbleWriter;
  typingTimer?: ReturnType<typeof setInterval>;
}

const TYPING_INTERVAL_MS = 50_000;
const PENDING_TTL_MS = 15_000;
const RECOVERY_TTL_MS = 60_000;

/**
 * Coordinates a QQ-triggered agent run: target selection, tool ordering,
 * deferred content, typing indicators, and run lifetime. Bubble layout and
 * stream I/O are delegated to BubbleWriter.
 */
export class RunFeedback {
  private readonly deps: RunFeedbackDeps;
  private pending: { openid: string; msgId: string; at: number } | null = null;
  private recovery: { openid: string; msgId: string; at: number } | null = null;
  private run: RunState | null = null;
  private lastCompletedText: string | undefined;
  private endPromise: Promise<void> = Promise.resolve();
  private endResolve?: () => void;

  constructor(deps: RunFeedbackDeps) {
    this.deps = deps;
  }

  markQQTrigger(openid: string, msgId: string): void {
    this.pending = { openid, msgId, at: Date.now() };
    this.recovery = null;
  }

  cancelRecovery(): void {
    this.recovery = null;
  }

  isQQRunActive(): boolean {
    return this.run !== null;
  }

  waitForEnd(): Promise<void> {
    return this.run ? this.endPromise : Promise.resolve();
  }

  /**
   * The final assistant text of the most recently completed QQ run.
   * No transcript is retained.
   */
  getLastMessage(): string | undefined {
    return this.lastCompletedText;
  }

  /**
   * Restart the current run's push with its latest text. This revives a stream
   * that may have died while the phone was offline; later deltas continue.
   */
  repushCurrent(): boolean {
    const run = this.run;
    const text = run?.currentText;
    if (!run || !text?.trim()) return false;
    // Push the current text in full. Do not rewrite resultSentLen: it belongs to
    // the assistant message currently being diffed, and changing it could drop
    // the beginning of the next message.
    run.writer.restartText(text);
    return true;
  }

  onAgentStart(): void {
    this.endPromise = new Promise((resolve) => {
      this.endResolve = resolve;
    });
    const now = Date.now();
    const pending = this.pending;
    this.pending = null;
    const target =
      pending && now - pending.at <= PENDING_TTL_MS
        ? pending
        : this.recovery && now - this.recovery.at <= RECOVERY_TTL_MS
          ? this.recovery
          : undefined;
    if (!target) return;
    const bot = this.deps.bot();
    if (!bot) return;

    const startedAt = Date.now();
    const writer = new BubbleWriter({
      bot: this.deps.bot,
      budget: this.deps.budget,
      openid: target.openid,
      msgId: target.msgId,
      startedAt,
      onWarn: this.deps.onWarn,
    });
    const run: RunState = {
      startedAt,
      openid: target.openid,
      msgId: target.msgId,
      thinkingSentLen: 0,
      finalizedText: "",
      currentText: "",
      resultSentLen: 0,
      tools: [],
      deferredThinking: "",
      deferredText: "",
      hadError: false,
      writer,
    };
    this.run = run;
    log.debug("run", "started", { msgId: run.msgId?.slice(0, 8) ?? "?" });

    const keepTyping = () => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    };
    keepTyping();
    run.typingTimer = setInterval(keepTyping, TYPING_INTERVAL_MS);
  }

  onToolStart(toolName: string, args?: unknown, toolCallId?: string): void {
    const run = this.run;
    if (!run || run.writer.dead) return;
    const id = toolCallId ?? toolName;
    if (run.tools.some((tool) => tool.id === id)) return;
    run.tools.push({ id, name: toolName, args, started: false, finished: false });
    this.startNextTool(run);
  }

  onToolEnd(toolName: string, isError: boolean, result?: unknown, toolCallId?: string): void {
    const run = this.run;
    if (!run || run.writer.dead) return;
    const id = toolCallId ?? toolName;
    const tool = run.tools.find((candidate) => candidate.id === id);
    if (!tool) return;
    tool.result = { isError, result };
    if (run.activeTool === id) this.finishTool(run, tool);
  }

  onAssistantDelta(snapshotText: string, snapshotThinking: string): void {
    const run = this.run;
    if (!run) return;

    const full = [run.finalizedText, snapshotText].filter((part) => part.trim()).join("\n\n");
    if (full.trim()) run.currentText = full;

    if (run.writer.dead) return;

    if (snapshotThinking.length > run.thinkingSentLen) {
      const thinkingDelta = snapshotThinking.slice(run.thinkingSentLen);
      run.thinkingSentLen = snapshotThinking.length;
      if (this.deps.getThinkingRelay()) {
        if (this.hasPendingTools(run)) {
          run.deferredThinking += thinkingDelta;
        } else {
          run.writer.pushThinking(thinkingDelta);
        }
      }
    }

    const delta = full.slice(run.resultSentLen);
    if (!delta) return;
    run.resultSentLen = full.length;
    if (this.hasPendingTools(run)) {
      run.deferredText += delta;
      return;
    }
    run.writer.pushText(delta);
  }

  async onAssistantFinal(text: string, isError: boolean): Promise<boolean> {
    const run = this.run;
    if (!run) return false;

    run.finalizedText = [run.finalizedText, text].filter((part) => part.trim()).join("\n\n");
    if (text.trim()) run.currentText = text;
    const delta = run.finalizedText.slice(run.resultSentLen);
    run.resultSentLen = run.finalizedText.length;
    if (!isError && text && delta) {
      if (this.hasPendingTools(run)) {
        run.deferredText += delta;
      } else {
        run.writer.pushText(delta);
      }
    }
    if (!isError && text) run.writer.closeBlock();

    run.thinkingSentLen = 0;
    if (isError) {
      run.hadError = true;
      this.recovery = { openid: run.openid, msgId: run.msgId ?? "", at: Date.now() };
    }

    const ok = await run.writer.flush();
    run.finalizedText = "";
    run.resultSentLen = 0;
    if (isError) return false;
    return ok && run.writer.hasPushed;
  }

  async onAgentEnd(): Promise<void> {
    const run = this.run;
    if (!run) {
      this.finishEnd();
      return;
    }
    await run.writer.whenIdle();
    if (!this.hasPendingTools(run)) this.flushDeferred(run);
    await run.writer.whenIdle();
    this.clearTimers();
    if (run.currentText.trim()) this.lastCompletedText = run.currentText;
    if (!run.hadError && run.writer.hasPushed) this.recovery = null;
    this.run = null;
    log.debug("run", "ended", {
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
    });
    if (!run.writer.hasPushed) {
      run.writer.dispose();
      this.finishEnd();
      return;
    }
    const ok = await run.writer.flush();
    if (ok) await run.writer.done();
    run.writer.dispose();
    this.finishEnd();
  }

  dispose(): void {
    this.clearTimers();
    this.run?.writer.dispose();
    this.run = null;
    this.pending = null;
    this.recovery = null;
    this.lastCompletedText = undefined;
    this.finishEnd();
  }

  private finishEnd(): void {
    this.endResolve?.();
    this.endResolve = undefined;
  }

  private hasPendingTools(run: RunState): boolean {
    return Boolean(run.activeTool) || run.tools.some((tool) => !tool.finished);
  }

  private flushDeferred(run: RunState): void {
    if (run.writer.dead) return;
    if (run.deferredThinking) {
      const thinking = run.deferredThinking;
      run.deferredThinking = "";
      run.writer.pushThinking(thinking);
    }
    if (run.deferredText) {
      const text = run.deferredText;
      run.deferredText = "";
      run.writer.pushText(text);
    }
  }

  private startNextTool(run: RunState): void {
    if (run.writer.dead || run.activeTool) return;
    const tool = run.tools.find((candidate) => !candidate.started);
    if (!tool) return;
    tool.started = true;
    run.activeTool = tool.id;
    run.writer.pushTool(tool.name, tool.args);
    if (tool.result) this.finishTool(run, tool);
  }

  private finishTool(run: RunState, tool: ToolCall): void {
    if (!tool.result || tool.finished) return;
    tool.finished = true;
    run.writer.pushToolResult(tool.result.result, tool.result.isError);
    run.writer.schedule(() => {
      if (this.run !== run) return;
      if (run.activeTool !== tool.id) return;
      run.activeTool = undefined;
      this.startNextTool(run);
      if (!this.hasPendingTools(run)) this.flushDeferred(run);
    });
  }

  private clearTimers(): void {
    const run = this.run;
    if (!run) return;
    if (run.typingTimer) clearInterval(run.typingTimer);
    run.typingTimer = undefined;
  }
}
