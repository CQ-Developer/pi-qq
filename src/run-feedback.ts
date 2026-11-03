import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream, type AppendStreamCheckpoint } from "./append-stream";
import type { ReplyBudget } from "./reply-budget";
import { log } from "./logger";
import { THINKING_HEADER, formatToolLine, formatToolResult } from "./run-format";

export interface RunFeedbackDeps {
  bot: () => QQBot | undefined;
  budget: ReplyBudget;
  getThinkingRelay: () => boolean;
  onWarn: (msg: string) => void;
}

type BlockKind = "none" | "thinking" | "tool" | "text";

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
  thinkingAtLineStart: boolean;
  snapshotText: string;
  finalizedText: string;
  resultSentLen: number;
  lastKind: BlockKind;
  cur: AppendStream | null;
  pendingResume?: AppendStreamCheckpoint;
  streamDead: boolean;
  resumeAttempts: number;
  pushedAny: boolean;
  bubbleChars: number;
  fenceOpen: boolean;
  fenceLen: number;
  fenceQuoted: boolean;
  lastChar: string;
  toolOpen: boolean;
  activeTool?: string;
  tools: ToolCall[];
  deferredThinking: string;
  deferredText: string;
  blockClosed: boolean;
  hadError: boolean;
  typingTimer?: ReturnType<typeof setInterval>;
}

const TYPING_INTERVAL_MS = 50_000;
const PENDING_TTL_MS = 15_000;
const RECOVERY_TTL_MS = 60_000;
const MAX_RESUME_ATTEMPTS = 2;
const MAX_BUBBLE_CHARS = 12_000;

function appendThinkingDelta(delta: string, run: RunState): string {
  run.thinkingAtLineStart = delta.endsWith("\n");
  return delta;
}

export class RunFeedback {
  private readonly deps: RunFeedbackDeps;
  private pending: { openid: string; msgId: string; at: number } | null = null;
  private recovery: { openid: string; msgId: string; at: number } | null = null;
  private run: RunState | null = null;
  private queue: Promise<void> = Promise.resolve();
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

    const run: RunState = {
      startedAt: Date.now(),
      openid: target.openid,
      msgId: target.msgId,
      thinkingSentLen: 0,
      thinkingAtLineStart: true,
      snapshotText: "",
      finalizedText: "",
      resultSentLen: 0,
      lastKind: "none",
      cur: null,
      streamDead: false,
      resumeAttempts: 0,
      pushedAny: false,
      bubbleChars: 0,
      fenceOpen: false,
      fenceLen: 0,
      fenceQuoted: false,
      lastChar: "",
      toolOpen: false,
      tools: [],
      deferredThinking: "",
      deferredText: "",
      blockClosed: false,
      hadError: false,
    };
    this.run = run;
    this.queue = Promise.resolve();
    log.debug("run", "started", { msgId: run.msgId?.slice(0, 8) ?? "?" });

    const keepTyping = () => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    };
    keepTyping();
    run.typingTimer = setInterval(keepTyping, TYPING_INTERVAL_MS);
  }

  onToolStart(toolName: string, args?: unknown, toolCallId?: string): void {
    const run = this.run;
    if (!run || run.streamDead) return;
    const id = toolCallId ?? toolName;
    if (run.tools.some((tool) => tool.id === id)) return;
    run.tools.push({ id, name: toolName, args, started: false, finished: false });
    this.startNextTool(run);
  }

  onToolEnd(toolName: string, isError: boolean, result?: unknown, toolCallId?: string): void {
    const run = this.run;
    if (!run || run.streamDead) return;
    const id = toolCallId ?? toolName;
    const tool = run.tools.find((candidate) => candidate.id === id);
    if (!tool) return;
    tool.result = { isError, result };
    if (run.activeTool === id) this.finishTool(run, tool);
  }

  onAssistantDelta(snapshotText: string, snapshotThinking: string): void {
    const run = this.run;
    if (!run || run.streamDead) return;

    if (snapshotThinking.length > run.thinkingSentLen) {
      const delta = snapshotThinking.slice(run.thinkingSentLen);
      run.thinkingSentLen = snapshotThinking.length;
      if (this.deps.getThinkingRelay()) {
        if (this.hasPendingTools(run)) {
          run.deferredThinking += delta;
        } else {
          const newBubble = this.startsNewBlock(run, "thinking");
          const prefix = this.beginBlock(run, "thinking", newBubble);
          this.push(
            run,
            `${prefix}${appendThinkingDelta(delta, run)}`,
            prefix.length > 0 || newBubble,
            false,
            newBubble,
            true,
          );
        }
      }
    }

    const full = [run.finalizedText, snapshotText].filter((part) => part.trim()).join("\n\n");
    const delta = full.slice(run.resultSentLen);
    if (!delta) return;
    run.resultSentLen = full.length;
    if (this.hasPendingTools(run)) {
      run.deferredText += delta;
      return;
    }
    const newBubble = this.startsNewBlock(run, "text");
    const prefix = this.beginBlock(run, "text", newBubble);
    this.push(run, `${prefix}${delta}`, prefix.length > 0 || newBubble, false, newBubble);
  }

  async onAssistantFinal(text: string, isError: boolean): Promise<boolean> {
    const run = this.run;
    if (!run) return false;

    run.finalizedText = [run.finalizedText, text].filter((part) => part.trim()).join("\n\n");
    run.snapshotText = "";
    const delta = run.finalizedText.slice(run.resultSentLen);
    run.resultSentLen = run.finalizedText.length;
    if (!isError && text && delta) {
      if (this.hasPendingTools(run)) {
        run.deferredText += delta;
      } else {
        const newBubble = this.startsNewBlock(run, "text");
        const prefix = this.beginBlock(run, "text", newBubble);
        this.push(run, `${prefix}${delta}`, prefix.length > 0 || newBubble, false, newBubble);
      }
    }
    if (!isError && text) run.blockClosed = true;

    run.thinkingSentLen = 0;
    if (isError) {
      run.hadError = true;
      this.recovery = { openid: run.openid, msgId: run.msgId ?? "", at: Date.now() };
    }

    const ok = await this.flushStream(run);
    run.finalizedText = "";
    run.snapshotText = "";
    run.resultSentLen = 0;
    if (isError) return false;
    return ok && run.pushedAny;
  }

  async onAgentEnd(): Promise<void> {
    const run = this.run;
    if (!run) {
      this.endResolve?.();
      this.endResolve = undefined;
      return;
    }
    await this.drainQueue();
    if (!this.hasPendingTools(run)) this.flushDeferred(run);
    await this.drainQueue();
    this.clearTimers();
    if (!run.hadError && run.pushedAny) this.recovery = null;
    this.run = null;
    log.debug("run", "ended", {
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
    });
    if (!run.pushedAny) {
      run.cur?.dispose();
      this.endResolve?.();
      this.endResolve = undefined;
      return;
    }
    const ok = await this.flushStream(run);
    if (ok && run.cur && !run.streamDead) {
      try {
        await run.cur.done();
      } catch (err) {
        log.warn("stream", "DONE failed", {
          msgId: run.msgId?.slice(0, 8) ?? "?",
          err,
        });
      }
    }
    run.cur?.dispose();
    this.endResolve?.();
    this.endResolve = undefined;
  }

  dispose(): void {
    this.clearTimers();
    this.run?.cur?.dispose();
    this.run = null;
    this.endResolve?.();
    this.endResolve = undefined;
  }

  private beginBlock(run: RunState, kind: BlockKind, newBubble = false): string {
    if (newBubble) {
      run.lastKind = kind;
      run.blockClosed = false;
      if (kind === "thinking") run.thinkingAtLineStart = true;
      return "";
    }
    if (run.lastKind === kind) return "";
    let prefix = "";
    if (run.lastKind !== "none") {
      if (run.lastKind === "thinking" && !run.thinkingAtLineStart) prefix += "\n";
      prefix += run.lastKind === "text" ? "\n\n" : "\n";
    }
    run.lastKind = kind;
    run.blockClosed = false;
    if (kind === "thinking") run.thinkingAtLineStart = true;
    return prefix;
  }

  private startsNewBlock(run: RunState, kind: BlockKind): boolean {
    return run.blockClosed || (run.lastKind !== "none" && run.lastKind !== kind);
  }

  private async closeOpenFence(run: RunState): Promise<boolean> {
    if (!run.fenceOpen) return true;
    const stream = this.ensureStream(run);
    if (!stream) return false;
    const ticks = "`".repeat(run.fenceLen);
    const closing = `\n${run.fenceQuoted ? "> " : ""}${ticks}\n`;
    try {
      await stream.append(closing);
      run.bubbleChars += closing.length;
      run.lastChar = "\n";
      run.fenceOpen = false;
      run.fenceLen = 0;
      run.fenceQuoted = false;
      return true;
    } catch (err) {
      if (run.cur === stream) this.handleStreamError(run, err as Error);
      return false;
    }
  }

  private hasPendingTools(run: RunState): boolean {
    return Boolean(run.activeTool) || run.tools.some((tool) => !tool.finished);
  }

  private flushDeferred(run: RunState): void {
    if (run.streamDead) return;
    if (run.deferredThinking) {
      const thinking = run.deferredThinking;
      run.deferredThinking = "";
      const newBubble = this.startsNewBlock(run, "thinking");
      const prefix = this.beginBlock(run, "thinking", newBubble);
      this.push(
        run,
        `${prefix}${appendThinkingDelta(thinking, run)}`,
        prefix.length > 0 || newBubble,
        false,
        newBubble,
        true,
      );
    }
    if (run.deferredText) {
      const text = run.deferredText;
      run.deferredText = "";
      const newBubble = this.startsNewBlock(run, "text");
      const prefix = this.beginBlock(run, "text", newBubble);
      this.push(run, `${prefix}${text}`, prefix.length > 0 || newBubble, false, newBubble);
    }
  }

  private startNextTool(run: RunState): void {
    if (run.streamDead || run.activeTool) return;
    const tool = run.tools.find((candidate) => !candidate.started);
    if (!tool) return;
    tool.started = true;
    run.activeTool = tool.id;
    run.toolOpen = true;
    const newBubble = run.lastKind !== "none";
    const prefix = this.beginBlock(run, "tool", newBubble);
    this.push(
      run,
      `${prefix}${formatToolLine(tool.name, tool.args)}\n\n`,
      prefix.length > 0 || newBubble,
      false,
      newBubble,
    );
    if (tool.result) this.finishTool(run, tool);
  }

  private finishTool(run: RunState, tool: ToolCall): void {
    if (!tool.result || tool.finished) return;
    tool.finished = true;
    const prefix = this.beginBlock(run, "tool");
    this.push(run, `${prefix}${formatToolResult(tool.result.result, tool.result.isError)}`, prefix.length > 0, true);
    void this.enqueue(async () => {
      if (this.run !== run || run.streamDead) return;
      if (run.activeTool !== tool.id) return;
      run.activeTool = undefined;
      this.startNextTool(run);
      if (!this.hasPendingTools(run)) this.flushDeferred(run);
    });
  }

  private push(
    run: RunState,
    text: string,
    blockBoundary = false,
    endTool = false,
    newBubble = false,
    thinking = false,
  ): void {
    if (!text || run.streamDead) return;
    void this.enqueue(async () => {
      if (this.run !== run || run.streamDead) return;
      if (blockBoundary && !(await this.closeOpenFence(run))) return;
      if (newBubble && run.cur && run.bubbleChars > 0 && !run.pendingResume) {
        await this.rotateStream(run);
        if (this.run !== run || run.streamDead) return;
      }
      if (
        !newBubble &&
        run.bubbleChars >= MAX_BUBBLE_CHARS &&
        run.cur &&
        !run.pendingResume &&
        !run.fenceOpen &&
        !run.toolOpen &&
        (blockBoundary || run.lastChar === "\n")
      ) {
        await this.rotateStream(run);
        if (this.run !== run || run.streamDead) return;
      }
      const stream = this.ensureStream(run);
      if (!stream) return;
      run.pushedAny = true;
      const outgoing = thinking && (!run.cur || run.bubbleChars === 0) ? `${THINKING_HEADER}${text}` : text;
      try {
        await stream.append(outgoing);
        run.bubbleChars += outgoing.length;
        this.trackFences(run, outgoing);
        run.lastChar = outgoing.slice(-1);
        if (endTool) run.toolOpen = false;
      } catch (err) {
        if (run.cur === stream) this.handleStreamError(run, err as Error);
      }
    });
  }

  private trackFences(run: RunState, text: string): void {
    const previousChar = run.lastChar;
    for (const match of text.matchAll(/(?:^|\n)[ \t>]*(`{3,})/g)) {
      if (match.index === 0 && previousChar && previousChar !== "\n") continue;
      const fenceLen = match[1].length;
      const lineEnd = text.indexOf("\n", match.index + match[0].length);
      const restOfLine = text.slice(match.index + match[0].length, lineEnd < 0 ? undefined : lineEnd);
      if (restOfLine.includes("`".repeat(fenceLen))) continue;
      if (!run.fenceOpen) {
        run.fenceOpen = true;
        run.fenceLen = fenceLen;
        run.fenceQuoted = match[0].includes(">");
      } else if (fenceLen >= run.fenceLen) {
        run.fenceOpen = false;
        run.fenceLen = 0;
        run.fenceQuoted = false;
      }
    }
  }

  private async rotateStream(run: RunState): Promise<void> {
    const stream = run.cur;
    if (!stream) return;
    try {
      if (run.lastChar && run.lastChar !== "\n") {
        await stream.append("\n");
        run.bubbleChars += 1;
        run.lastChar = "\n";
        run.thinkingAtLineStart = true;
      }
      await stream.flush();
      await stream.done();
    } catch (err) {
      log.warn("stream", "bubble split failed", {
        msgId: run.msgId?.slice(0, 8) ?? "?",
        err,
      });
      if (run.cur === stream) this.handleStreamError(run, err as Error);
      return;
    }
    stream.dispose();
    if (run.cur === stream) run.cur = null;
    run.bubbleChars = 0;
    run.fenceOpen = false;
    run.fenceLen = 0;
    run.fenceQuoted = false;
    run.lastChar = "";
    run.thinkingAtLineStart = true;
    log.debug("stream", "bubble split", {
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
    });
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      const current = this.queue;
      await current;
      if (current === this.queue) return;
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => {});
    return next;
  }

  private ensureStream(run: RunState): AppendStream | null {
    if (run.streamDead) return null;
    if (run.cur) return run.cur;
    const bot = this.deps.bot();
    if (!bot || !run.msgId) return null;
    const resume = run.pendingResume;
    run.pendingResume = undefined;
    const stream = new AppendStream(bot.messageApi, bot.getCredentials(), run.openid, run.msgId, {
      resume,
      onError: (err) => {
        void this.enqueue(async () => {
          if (this.run !== run) return;
          if (run.cur === stream) this.handleStreamError(run, err);
        });
      },
    });
    run.cur = stream;
    if (!resume) this.deps.budget.noteStreamBubble(run.msgId);
    return stream;
  }

  private async flushStream(run: RunState): Promise<boolean> {
    await this.drainQueue();
    if (run.streamDead) return false;
    if (!run.cur && !run.pendingResume) return true;
    for (let attempt = 0; attempt <= MAX_RESUME_ATTEMPTS; attempt++) {
      const stream = this.ensureStream(run);
      if (!stream) return false;
      try {
        await stream.flush();
        await this.queue;
        if (run.streamDead) return false;
        if (run.cur !== stream) continue;
        return true;
      } catch (err) {
        this.handleStreamError(run, err as Error);
        if (run.streamDead) return false;
      }
    }
    this.killStream(run, "resume attempts exhausted");
    return false;
  }

  private handleStreamError(run: RunState, err: Error): void {
    if (run.streamDead) return;
    const stream = run.cur;
    const checkpoint = stream?.checkpoint() ?? null;
    stream?.dispose();
    run.cur = null;
    log.warn("stream", "stream error", {
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
      err,
    });
    if (checkpoint && run.resumeAttempts < MAX_RESUME_ATTEMPTS) {
      run.resumeAttempts += 1;
      run.pendingResume = checkpoint;
      return;
    }
    this.killStream(run, err.message);
  }

  private killStream(run: RunState, reason: string): void {
    if (run.streamDead) return;
    run.streamDead = true;
    run.pendingResume = undefined;
    run.cur?.dispose();
    run.cur = null;
    log.warn("stream", "stream unavailable", {
      msgId: run.msgId?.slice(0, 8) ?? "?",
      reason,
    });
    this.deps.onWarn(`Stream unavailable; falling back to text (${reason}).`);
  }

  private clearTimers(): void {
    const run = this.run;
    if (!run) return;
    if (run.typingTimer) clearInterval(run.typingTimer);
    run.typingTimer = undefined;
  }
}
