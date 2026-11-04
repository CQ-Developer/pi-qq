import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AppendStream, type AppendStreamCheckpoint } from "./stream-session";
import type { ReplyBudget } from "../quota/reply-quota";
import { log } from "../infra/file-logger";
import { formatSkillBlock, formatToolLine, formatToolResult, thinkingHeader } from "./stream-block-format";
import { t } from "../infra/i18n";

type BlockKind = "none" | "thinking" | "tool" | "text";

const MAX_RESUME_ATTEMPTS = 2;
const MAX_BUBBLE_CHARS = 12_000;

export interface BubbleWriterDeps {
  bot: () => QQBot | undefined;
  budget: ReplyBudget;
  openid: string;
  msgId?: string;
  startedAt: number;
  onWarn: (msg: string) => void;
}

/**
 * Owns one run's QQ stream: block layout, bubble rotation, fence tracking, and
 * stream recovery. Operations are serialized so callers can enqueue in event
 * order without waiting for network round-trips.
 */
export class BubbleWriter {
  private cur: AppendStream | null = null;
  private pendingResume?: AppendStreamCheckpoint;
  private streamDead = false;
  private resumeAttempts = 0;
  private pushedAny = false;
  private bubbleChars = 0;
  private fenceOpen = false;
  private fenceLen = 0;
  private fenceQuoted = false;
  private lastChar = "";
  private lastKind: BlockKind = "none";
  private blockClosed = false;
  private thinkingAtLineStart = true;
  private toolOpen = false;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly deps: BubbleWriterDeps) {}

  get hasPushed(): boolean {
    return this.pushedAny;
  }

  get dead(): boolean {
    return this.streamDead;
  }

  /** Mark the current block as complete so the next content starts a new bubble. */
  closeBlock(): void {
    this.blockClosed = true;
  }

  pushThinking(delta: string): void {
    if (this.streamDead || this.disposed) return;
    const newBubble = this.startsNewBlock("thinking");
    const prefix = this.beginBlock("thinking", newBubble);
    this.thinkingAtLineStart = delta.endsWith("\n");
    this.push(`${prefix}${delta}`, prefix.length > 0 || newBubble, false, newBubble, true);
  }

  pushText(text: string): void {
    if (this.streamDead || this.disposed) return;
    const newBubble = this.startsNewBlock("text");
    const prefix = this.beginBlock("text", newBubble);
    this.push(`${prefix}${text}`, prefix.length > 0 || newBubble, false, newBubble);
  }

  pushTool(name: string, args: unknown): void {
    if (this.streamDead || this.disposed) return;
    this.toolOpen = true;
    const newBubble = this.lastKind !== "none";
    const prefix = this.beginBlock("tool", newBubble);
    log.debug("stream", "stream timing", {
      phase: "tool queued",
      msgId: this.logMsgId(),
      tool: name,
      at: Date.now(),
      hasStream: Boolean(this.cur),
    });
    this.push(
      `${prefix}${formatToolLine(name, args)}\n\n`,
      prefix.length > 0 || newBubble,
      false,
      newBubble,
      false,
      "tool",
    );
  }

  pushSkill(name: string): void {
    if (this.streamDead || this.disposed) return;
    this.toolOpen = false;
    const newBubble = true;
    const prefix = this.beginBlock("tool", newBubble);
    this.push(`${prefix}${formatSkillBlock(name)}`, prefix.length > 0 || newBubble, false, newBubble, false, "skill");
  }

  pushToolResult(result: unknown, isError: boolean): void {
    if (this.streamDead || this.disposed) return;
    const prefix = this.beginBlock("tool");
    this.push(`${prefix}${formatToolResult(result, isError)}`, prefix.length > 0, true);
  }

  /** Run `op` after all currently queued appends, unless the stream died first. */
  schedule(op: () => void): void {
    void this.enqueue(async () => {
      if (this.streamDead || this.disposed) return;
      op();
    });
  }

  /**
   * Start a fresh bubble and push the current text again, reviving a stream
   * that died while the phone was offline. Later deltas continue in this bubble.
   */
  restartText(text: string, target?: { openid: string; msgId: string }): void {
    if (!text || this.disposed) return;
    void this.enqueue(async () => {
      if (this.disposed) return;
      if (this.fenceOpen) await this.closeOpenFence();
      if (this.cur) await this.rotateStream();

      if (target) {
        this.deps.openid = target.openid;
        this.deps.msgId = target.msgId;
      }
      this.streamDead = false;
      this.pendingResume = undefined;
      this.resumeAttempts = 0;
      this.lastKind = "none";
      this.blockClosed = false;
      this.toolOpen = false;
      this.fenceOpen = false;
      this.fenceLen = 0;
      this.fenceQuoted = false;
      this.lastChar = "";
      this.thinkingAtLineStart = true;
      this.bubbleChars = 0;
      this.pushText(text);
    });
  }

  async whenIdle(): Promise<void> {
    await this.drainQueue();
  }

  async flush(): Promise<boolean> {
    await this.drainQueue();
    if (this.streamDead || this.disposed) return false;
    if (!this.cur && !this.pendingResume) return true;
    for (let attempt = 0; attempt <= MAX_RESUME_ATTEMPTS; attempt++) {
      const stream = this.ensureStream();
      if (!stream) return false;
      try {
        await stream.flush();
        await this.queue;
        if (this.streamDead) return false;
        if (this.cur !== stream) continue;
        return true;
      } catch (err) {
        this.handleStreamError(err as Error);
        if (this.streamDead) return false;
      }
    }
    this.killStream("resume attempts exhausted");
    return false;
  }

  async done(): Promise<void> {
    if (this.streamDead || this.disposed || !this.cur) return;
    try {
      await this.cur.done();
    } catch (err) {
      log.warn("stream", "DONE failed", { msgId: this.logMsgId(), err });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cur?.dispose();
    this.cur = null;
  }

  private logMsgId(): string {
    return this.deps.msgId?.slice(0, 8) ?? "?";
  }

  private beginBlock(kind: BlockKind, newBubble = false): string {
    if (newBubble) {
      this.lastKind = kind;
      this.blockClosed = false;
      if (kind === "thinking") this.thinkingAtLineStart = true;
      return "";
    }
    if (this.lastKind === kind) return "";
    let prefix = "";
    if (this.lastKind !== "none") {
      if (this.lastKind === "thinking" && !this.thinkingAtLineStart) prefix += "\n";
      prefix += this.lastKind === "text" ? "\n\n" : "\n";
    }
    this.lastKind = kind;
    this.blockClosed = false;
    if (kind === "thinking") this.thinkingAtLineStart = true;
    return prefix;
  }

  private startsNewBlock(kind: BlockKind): boolean {
    return this.blockClosed || (this.lastKind !== "none" && this.lastKind !== kind);
  }

  private async closeOpenFence(): Promise<boolean> {
    if (!this.fenceOpen) return true;
    const stream = this.ensureStream();
    if (!stream) return false;
    const ticks = "`".repeat(this.fenceLen);
    const closing = `\n${this.fenceQuoted ? "> " : ""}${ticks}\n`;
    try {
      await stream.append(closing);
      this.bubbleChars += closing.length;
      this.lastChar = "\n";
      this.fenceOpen = false;
      this.fenceLen = 0;
      this.fenceQuoted = false;
      return true;
    } catch (err) {
      if (this.cur === stream) this.handleStreamError(err as Error);
      return false;
    }
  }

  private push(
    text: string,
    blockBoundary = false,
    endTool = false,
    newBubble = false,
    thinking = false,
    trace?: string,
  ): void {
    if (!text || this.streamDead || this.disposed) return;
    const queuedAt = trace ? Date.now() : 0;
    void this.enqueue(async () => {
      if (this.streamDead || this.disposed) return;
      if (trace) {
        log.debug("stream", "stream timing", {
          phase: "append start",
          trace,
          msgId: this.logMsgId(),
          waitedMs: Date.now() - queuedAt,
          hasStream: Boolean(this.cur),
        });
      }
      if (blockBoundary && !(await this.closeOpenFence())) return;
      if (newBubble && this.cur && this.bubbleChars > 0 && !this.pendingResume) {
        await this.rotateStream();
        if (this.streamDead || this.disposed) return;
      }
      if (
        !newBubble &&
        this.bubbleChars >= MAX_BUBBLE_CHARS &&
        this.cur &&
        !this.pendingResume &&
        !this.fenceOpen &&
        !this.toolOpen &&
        (blockBoundary || this.lastChar === "\n")
      ) {
        await this.rotateStream();
        if (this.streamDead || this.disposed) return;
      }
      const stream = this.ensureStream();
      if (!stream) return;
      this.pushedAny = true;
      const outgoing = thinking && (!this.cur || this.bubbleChars === 0) ? `${thinkingHeader()}${text}` : text;
      try {
        await stream.append(outgoing);
        this.bubbleChars += outgoing.length;
        this.trackFences(outgoing);
        this.lastChar = outgoing.slice(-1);
        if (endTool) this.toolOpen = false;
        if (trace) {
          log.debug("stream", "stream timing", {
            phase: "append done",
            trace,
            msgId: this.logMsgId(),
            totalMs: Date.now() - queuedAt,
            bubbleChars: this.bubbleChars,
          });
        }
      } catch (err) {
        if (this.cur === stream) this.handleStreamError(err as Error);
      }
    });
  }

  private trackFences(text: string): void {
    const previousChar = this.lastChar;
    for (const match of text.matchAll(/(?:^|\n)[ \t>]*(`{3,})/g)) {
      if (match.index === 0 && previousChar && previousChar !== "\n") continue;
      const fenceLen = match[1].length;
      const lineEnd = text.indexOf("\n", match.index + match[0].length);
      const restOfLine = text.slice(match.index + match[0].length, lineEnd < 0 ? undefined : lineEnd);
      if (restOfLine.includes("`".repeat(fenceLen))) continue;
      if (!this.fenceOpen) {
        this.fenceOpen = true;
        this.fenceLen = fenceLen;
        this.fenceQuoted = match[0].includes(">");
      } else if (fenceLen >= this.fenceLen) {
        this.fenceOpen = false;
        this.fenceLen = 0;
        this.fenceQuoted = false;
      }
    }
  }

  private async rotateStream(): Promise<void> {
    const stream = this.cur;
    if (!stream) return;
    try {
      if (this.lastChar && this.lastChar !== "\n") {
        await stream.append("\n");
        this.bubbleChars += 1;
        this.lastChar = "\n";
        this.thinkingAtLineStart = true;
      }
      await stream.flush();
      await stream.done();
    } catch (err) {
      log.warn("stream", "bubble split failed", { msgId: this.logMsgId(), err });
      if (this.cur === stream) this.handleStreamError(err as Error);
      return;
    }
    stream.dispose();
    if (this.cur === stream) this.cur = null;
    this.bubbleChars = 0;
    this.fenceOpen = false;
    this.fenceLen = 0;
    this.fenceQuoted = false;
    this.lastChar = "";
    this.thinkingAtLineStart = true;
    log.debug("stream", "bubble split", {
      msgId: this.logMsgId(),
      elapsedMs: Date.now() - this.deps.startedAt,
    });
  }

  private drainQueue(): Promise<void> {
    return (async () => {
      for (;;) {
        const current = this.queue;
        await current;
        if (current === this.queue) return;
      }
    })();
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => {});
    return next;
  }

  private ensureStream(): AppendStream | null {
    if (this.streamDead || this.disposed) return null;
    if (this.cur) return this.cur;
    const bot = this.deps.bot();
    if (!bot || !this.deps.msgId) return null;
    const resume = this.pendingResume;
    this.pendingResume = undefined;
    const stream = new AppendStream(bot.messageApi, bot.getCredentials(), this.deps.openid, this.deps.msgId, {
      resume,
      onError: (err) => {
        void this.enqueue(async () => {
          if (this.disposed || this.cur !== stream) return;
          this.handleStreamError(err);
        });
      },
      onDebug: (message) => log.debug("stream", message, { msgId: this.logMsgId() }),
    });
    this.cur = stream;
    if (!resume) this.deps.budget.noteStreamBubble(this.deps.msgId);
    return stream;
  }

  private handleStreamError(err: Error): void {
    if (this.streamDead) return;
    const stream = this.cur;
    const checkpoint = stream?.checkpoint() ?? null;
    stream?.dispose();
    this.cur = null;
    log.warn("stream", "stream error", {
      msgId: this.logMsgId(),
      elapsedMs: Date.now() - this.deps.startedAt,
      err,
    });
    if (checkpoint && this.resumeAttempts < MAX_RESUME_ATTEMPTS) {
      this.resumeAttempts += 1;
      this.pendingResume = checkpoint;
      return;
    }
    this.killStream(err.message);
  }

  private killStream(reason: string): void {
    if (this.streamDead) return;
    this.streamDead = true;
    this.pendingResume = undefined;
    this.cur?.dispose();
    this.cur = null;
    log.warn("stream", "stream unavailable", { msgId: this.logMsgId(), reason });
    this.deps.onWarn(t("stream.unavailable", { reason }));
  }
}
