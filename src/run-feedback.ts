import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream, type AppendStreamCheckpoint } from "./append-stream";
import type { ReplyBudget } from "./reply-budget";
import { log } from "./logger";

export interface RunFeedbackDeps {
  bot: () => QQBot | undefined;
  budget: ReplyBudget;
  getThinkingRelay: () => boolean;
  onWarn: (msg: string) => void;
  bubbleGapMs?: number;
}

type BlockKind = "none" | "thinking" | "tool" | "text";

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
  toolActive: number;
  blockClosed: boolean;
  typingTimer?: ReturnType<typeof setInterval>;
}

const TYPING_INTERVAL_MS = 50_000;
const PENDING_TTL_MS = 15_000;
const MAX_RESUME_ATTEMPTS = 2;
const MAX_BUBBLE_CHARS = 12_000;
const BUBBLE_CREATE_GAP_MS = 300;
const ARG_MAX_CHARS = 200;
const RESULT_MAX_CHARS = 600;
const RESULT_MAX_LINES = 8;
const ARG_KEYS = ["command", "path", "file_path", "filename", "pattern", "query", "url"];

function inlineCode(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const ticks = "`".repeat(Math.max(1, ...runs.map((run) => run.length + 1)));
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

function truncateText(text: string, maxChars: number, maxLines: number): string {
  let out = text;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? `${out}…` : out;
}

function primaryArg(args: unknown): string {
  let value: string | undefined;
  if (typeof args === "string") {
    value = args;
  } else if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ARG_KEYS) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate) {
        value = candidate;
        break;
      }
    }
    if (!value) {
      try {
        value = JSON.stringify(args);
      } catch {
        value = String(args);
      }
    }
  } else if (args !== undefined && args !== null) {
    value = String(args);
  }
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > ARG_MAX_CHARS ? `${normalized.slice(0, ARG_MAX_CHARS)}…` : normalized;
}

export function formatToolLine(name: string, args: unknown): string {
  const primary = primaryArg(args);
  return primary ? `[${name}] ${inlineCode(primary)}` : `[${name}]`;
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return result === undefined || result === null ? "" : String(result);
  const record = result as Record<string, unknown>;
  const structured = record.structuredContent;
  if (Array.isArray(record.content)) {
    const parts = record.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string",
      )
      .map((block) => block.text);
    if (parts.some((part) => part.trim())) return parts.join("\n");
    if (!structured && parts.length > 0) return "";
  }
  if (typeof structured === "string") return structured;
  if (structured && typeof structured === "object") {
    const output = (structured as Record<string, unknown>).output;
    if (typeof output === "string") return output;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function formatToolResult(result: unknown, isError: boolean): string {
  let text = resultText(result);
  text = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (!text) text = "(no output)";
  text = truncateText(text, RESULT_MAX_CHARS, RESULT_MAX_LINES);
  if (isError) text = `❌ ${text}`;
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${text}\n${fence}\n`;
}

function quoteThinking(delta: string, run: RunState): string {
  let out = "";
  for (const ch of delta) {
    if (run.thinkingAtLineStart) {
      out += ch === "\n" ? ">" : "> ";
      run.thinkingAtLineStart = false;
    }
    out += ch;
    if (ch === "\n") run.thinkingAtLineStart = true;
  }
  return out;
}

export class RunFeedback {
  private readonly deps: RunFeedbackDeps;
  private pending: { openid: string; msgId: string; at: number } | null = null;
  private run: RunState | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: RunFeedbackDeps) {
    this.deps = deps;
  }

  markQQTrigger(openid: string, msgId: string): void {
    this.pending = { openid, msgId, at: Date.now() };
  }

  isQQRunActive(): boolean {
    return this.run !== null;
  }

  onAgentStart(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) return;
    const bot = this.deps.bot();
    if (!bot) return;

    const run: RunState = {
      startedAt: Date.now(),
      openid: pending.openid,
      msgId: pending.msgId,
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
      toolActive: 0,
      blockClosed: false,
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

  onToolStart(toolName: string, args?: unknown): void {
    const run = this.run;
    if (!run || run.streamDead) return;
    const newGroup = run.toolActive === 0;
    const newBubble = newGroup && (run.lastKind !== "none" || run.blockClosed);
    run.toolActive += 1;
    if (newGroup) run.toolOpen = true;
    const prefix = this.beginBlock(run, "tool", newBubble);
    this.push(run, `${prefix}${formatToolLine(toolName, args)}\n`, prefix.length > 0 || newBubble, false, newBubble);
  }

  onToolEnd(toolName: string, isError: boolean, result?: unknown): void {
    const run = this.run;
    if (!run || run.streamDead) return;
    const endTool = run.toolActive <= 1;
    run.toolActive = Math.max(0, run.toolActive - 1);
    const prefix = this.beginBlock(run, "tool");
    this.push(run, `${prefix}${formatToolResult(result, isError)}`, prefix.length > 0, endTool);
  }

  onAssistantDelta(snapshotText: string, snapshotThinking: string): void {
    const run = this.run;
    if (!run || run.streamDead) return;

    if (snapshotThinking.length > run.thinkingSentLen) {
      const delta = snapshotThinking.slice(run.thinkingSentLen);
      run.thinkingSentLen = snapshotThinking.length;
      if (this.deps.getThinkingRelay()) {
        const newBubble = this.startsNewBlock(run, "thinking");
        const prefix = this.beginBlock(run, "thinking", newBubble);
        this.push(run, `${prefix}${quoteThinking(delta, run)}`, prefix.length > 0 || newBubble, false, newBubble);
      }
    }

    const full = [run.finalizedText, snapshotText].filter((part) => part.trim()).join("\n\n");
    const delta = full.slice(run.resultSentLen);
    if (!delta) return;
    run.resultSentLen = full.length;
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
      const newBubble = this.startsNewBlock(run, "text");
      const prefix = this.beginBlock(run, "text", newBubble);
      this.push(run, `${prefix}${delta}`, prefix.length > 0 || newBubble, false, newBubble);
    }
    if (!isError && text) run.blockClosed = true;

    if (run.lastKind === "thinking" && !run.thinkingAtLineStart) {
      this.push(run, "\n");
      run.thinkingAtLineStart = true;
    }
    run.thinkingSentLen = 0;

    const ok = await this.flushStream(run);
    run.finalizedText = "";
    run.snapshotText = "";
    run.resultSentLen = 0;
    if (isError) return false;
    return ok && run.pushedAny;
  }

  async onAgentEnd(): Promise<void> {
    const run = this.run;
    if (!run) return;
    await this.queue;
    this.clearTimers();
    this.run = null;
    log.debug("run", "ended", {
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
    });
    if (!run.pushedAny) {
      run.cur?.dispose();
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
  }

  dispose(): void {
    this.clearTimers();
    this.run?.cur?.dispose();
    this.run = null;
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

  private push(run: RunState, text: string, blockBoundary = false, endTool = false, newBubble = false): void {
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
      try {
        await stream.append(text);
        run.bubbleChars += text.length;
        this.trackFences(run, text);
        run.lastChar = text.slice(-1);
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
    await new Promise((resolve) => setTimeout(resolve, this.deps.bubbleGapMs ?? BUBBLE_CREATE_GAP_MS));
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
    await this.queue;
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
