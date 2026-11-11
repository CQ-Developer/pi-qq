import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { BubbleWriter, type RepushBlock, type RepushTool } from "./bubble-writer";
import { RunTimeline, type TimelineTool } from "./run-timeline";
import { policyFor } from "./reply-policy";
import type { ReplyBudget } from "../quota/reply-quota";
import type { ReplyType } from "../infra/reply-type";
import { isLogEnabled, log } from "../infra/file-logger";

export interface RunFeedbackDeps {
  bot: () => QQBot | undefined;
  budget: ReplyBudget;
  getReplyType: () => ReplyType;
  onWarn: (msg: string) => void;
}

interface RunState {
  startedAt: number;
  openid: string;
  msgId?: string;
  thinkingSentLen: number;
  finalizedText: string;
  resultSentLen: number;
  deferredThinking: string;
  deferredText: string;
  timeline: RunTimeline;
  writer: BubbleWriter;
  typingTimer?: ReturnType<typeof setInterval>;
}

export type RepushResult =
  | {
      ok: true;
      thinkingLength: number;
      toolCount: number;
      textLength: number;
    }
  | { ok: false; reason: "no-run" | "empty" };

const TYPING_INTERVAL_MS = 50_000;
const PENDING_TTL_MS = 15_000;
const RECOVERY_TTL_MS = 60_000;

function toRepushTool(tool: TimelineTool): RepushTool {
  return {
    name: tool.name,
    args: tool.args,
    ...(tool.skillName ? { skillName: tool.skillName } : {}),
    ...(tool.result ? { result: tool.result } : {}),
  };
}

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

  getLastMessage(): string | undefined {
    return this.lastCompletedText;
  }

  repushCurrent(openid: string, msgId: string): RepushResult {
    const run = this.run;
    if (!run) {
      log.debug("run", "stream timing", {
        phase: "last repush ignored",
        reason: "no-run",
      });
      return { ok: false, reason: "no-run" };
    }

    const snapshot = run.timeline.snapshot();
    const replyType = this.deps.getReplyType();
    const blocks: RepushBlock[] = [];
    if (replyType === "full") {
      if (snapshot.thinking.trim()) {
        blocks.push({ kind: "thinking", text: snapshot.thinking });
      }
      for (const tool of snapshot.tools) {
        blocks.push({ kind: "tool", tool: toRepushTool(tool) });
      }
    }
    if (snapshot.text.trim()) {
      blocks.push({ kind: "text", text: snapshot.text });
    }

    const thinkingLength = snapshot.thinking.length;
    const toolCount = blocks.filter((block) => block.kind === "tool").length;
    const textLength = snapshot.text.length;
    if (blocks.length === 0) {
      log.debug("run", "stream timing", {
        phase: "last repush ignored",
        reason: "empty",
        replyType,
        textLength,
        thinkingLength,
        toolCount,
        writerDead: run.writer.dead,
        ...this.diagnostics(run),
      });
      return { ok: false, reason: "empty" };
    }

    log.debug("run", "stream timing", {
      phase: "last repush",
      msgId: msgId.slice(0, 8),
      replyType,
      textLength,
      thinkingLength,
      toolCount,
      writerDead: run.writer.dead,
      ...this.diagnostics(run),
    });
    run.openid = openid;
    run.msgId = msgId;
    run.writer.restartSnapshot(blocks, { openid, msgId });
    run.deferredThinking = "";
    run.deferredText = "";
    return { ok: true, thinkingLength, toolCount, textLength };
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
    if (!target) {
      log.debug("run", "run started", {
        phase: "no qq target",
        pendingAgeMs: pending ? now - pending.at : null,
        recoveryAgeMs: this.recovery ? now - this.recovery.at : null,
        pendingTtlMs: PENDING_TTL_MS,
        recoveryTtlMs: RECOVERY_TTL_MS,
      });
      return;
    }
    const bot = this.deps.bot();
    if (!bot) {
      log.debug("run", "run started", { phase: "no bot", msgId: target.msgId.slice(0, 8) });
      return;
    }

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
      resultSentLen: 0,
      deferredThinking: "",
      deferredText: "",
      timeline: new RunTimeline(),
      writer,
    };
    this.run = run;
    if (isLogEnabled("debug")) {
      log.debug("run", "run started", {
        msgId: run.msgId?.slice(0, 8) ?? "?",
        source: target === pending ? "pending" : "recovery",
        targetAgeMs: now - target.at,
        replyType: this.deps.getReplyType(),
        budget: this.deps.budget.snapshot(),
      });
    }

    const keepTyping = () => {
      void bot.sendTyping({ scope: "c2c", targetId: run.openid }, 60).catch(() => {});
    };
    keepTyping();
    run.typingTimer = setInterval(keepTyping, TYPING_INTERVAL_MS);
  }

  onToolStart(toolName: string, args?: unknown, toolCallId?: string): void {
    const run = this.run;
    const id = toolCallId ?? toolName;
    if (!run) {
      log.debug("run", "tool start", { phase: "ignored: no active run", toolName, toolCallId: id });
      return;
    }
    const tool = run.timeline.addTool(toolName, args, id);
    if (!tool) return;
    log.debug("run", "tool start", {
      phase: "queued",
      toolName,
      toolCallId: id,
      skillName: tool.skillName ?? null,
      ...this.diagnostics(run),
    });
    this.advanceTools(run);
  }

  onToolEnd(toolName: string, isError: boolean, result?: unknown, toolCallId?: string): void {
    const run = this.run;
    const id = toolCallId ?? toolName;
    if (!run) {
      log.debug("run", "tool end", { phase: "ignored: no active run", toolName, toolCallId: id });
      return;
    }
    const tool = run.timeline.completeTool(id, isError, result);
    if (!tool) {
      log.debug("run", "tool end", { phase: "ignored: unknown tool", toolName, toolCallId: id });
      return;
    }
    log.debug("run", "tool end", {
      phase: "result recorded",
      toolName,
      toolCallId: id,
      isError,
      ...this.diagnostics(run),
    });
    this.advanceTools(run);
  }

  onAssistantDelta(snapshotText: string, snapshotThinking: string): void {
    const run = this.run;
    if (!run) return;

    const policy = this.policy();
    const full = [run.finalizedText, snapshotText].filter((part) => part.trim()).join("\n\n");
    run.timeline.updateAssistant(full, snapshotThinking);

    if (snapshotThinking.length > run.thinkingSentLen) {
      const thinkingDelta = snapshotThinking.slice(run.thinkingSentLen);
      run.thinkingSentLen = snapshotThinking.length;
      if (!run.writer.dead && policy.relayThinking) {
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
    if (run.writer.dead) return;
    if (policy.deferTextWhileToolsPending && this.hasPendingTools(run)) {
      run.deferredText += delta;
      return;
    }
    run.writer.pushText(delta);
  }

  async onAssistantFinal(text: string, isError: boolean): Promise<boolean> {
    const run = this.run;
    if (!run) {
      log.debug("run", "stream takeover decision", {
        phase: "assistant final ignored: no active run",
        textLength: text.length,
        isError,
      });
      return false;
    }

    const policy = this.policy();
    run.timeline.finishAssistant(text, isError);
    run.finalizedText = [run.finalizedText, text].filter((part) => part.trim()).join("\n\n");
    const delta = run.finalizedText.slice(run.resultSentLen);
    run.resultSentLen = run.finalizedText.length;
    if (!isError && text && delta && !run.writer.dead) {
      if (policy.deferTextWhileToolsPending && this.hasPendingTools(run)) {
        run.deferredText += delta;
      } else {
        run.writer.pushText(delta);
      }
    }
    if (!isError && text) run.writer.closeBlock();

    run.thinkingSentLen = 0;
    if (isError) {
      this.recovery = { openid: run.openid, msgId: run.msgId ?? "", at: Date.now() };
    }

    const hadPendingTools = this.hasPendingTools(run);
    const ok = await run.writer.flush();
    const streamTookOver = !isError && ok && run.writer.hasPushed;
    log.debug("run", "stream takeover decision", {
      phase: "assistant final",
      textLength: text.length,
      deltaLength: delta.length,
      isError,
      hadPendingTools,
      flushOk: ok,
      hasPushed: run.writer.hasPushed,
      streamTookOver,
      deferredTextLen: run.deferredText.length,
      deferredThinkingLen: run.deferredThinking.length,
      ...this.diagnostics(run),
    });
    run.finalizedText = "";
    run.resultSentLen = 0;
    if (isError) return false;
    return streamTookOver;
  }

  async onAgentEnd(): Promise<void> {
    const run = this.run;
    if (!run) {
      this.finishEnd();
      return;
    }
    await run.writer.whenIdle();
    const hasPendingTools = this.hasPendingTools(run);
    if (!hasPendingTools) this.flushDeferred(run);
    await run.writer.whenIdle();
    this.clearTimers();
    if (run.timeline.currentText.trim()) this.lastCompletedText = run.timeline.currentText;
    if (!run.timeline.error && run.writer.hasPushed) this.recovery = null;
    log.debug("run", "run ended", {
      phase: "cleanup",
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
      hasPendingTools,
      hasPushed: run.writer.hasPushed,
      lastCompletedTextLength: this.lastCompletedText?.length ?? 0,
      ...this.diagnostics(run),
    });
    log.debug("run", "run ended", {
      phase: "finished",
      msgId: run.msgId?.slice(0, 8) ?? "?",
      elapsedMs: Date.now() - run.startedAt,
    });
    if (run.writer.hasPushed) {
      const ok = await run.writer.flush();
      if (ok) await run.writer.done();
    }
    run.writer.dispose();
    if (this.run === run) this.run = null;
    this.finishEnd();
  }

  dispose(): void {
    const run = this.run;
    if (run) {
      log.debug("run", "run ended", { phase: "dispose", ...this.diagnostics(run) });
    }
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

  private policy() {
    return policyFor(this.deps.getReplyType());
  }

  private hasPendingTools(run: RunState): boolean {
    return run.timeline.hasPendingTools();
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

  private advanceTools(run: RunState): void {
    const relayTools = this.policy().relayTools;
    for (;;) {
      const active = run.timeline.active;
      if (active) {
        if (!active.result) return;
        if (!run.writer.dead && relayTools && !active.skillName) {
          run.writer.pushToolResult(active.result.result, active.result.isError, active.name, active.args);
        }
        const finished = run.timeline.finishActiveTool();
        if (finished) {
          log.debug("run", "tool end", {
            phase: "output finished",
            toolName: finished.name,
            toolCallId: finished.id,
            isError: finished.result?.isError ?? false,
            ...this.diagnostics(run),
          });
        }
        if (!this.hasPendingTools(run)) this.flushDeferred(run);
        continue;
      }
      const tool = run.timeline.startNextTool();
      if (!tool) return;
      log.debug("run", "tool start", {
        phase: "output started",
        toolName: tool.name,
        toolCallId: tool.id,
        skillName: tool.skillName ?? null,
        ...this.diagnostics(run),
      });
      if (!run.writer.dead && relayTools) {
        if (tool.skillName) {
          run.writer.pushSkill(tool.skillName);
        } else {
          run.writer.pushTool(tool.name, tool.args);
        }
      }
      if (!tool.result) return;
    }
  }

  private clearTimers(): void {
    const run = this.run;
    if (!run) return;
    if (run.typingTimer) clearInterval(run.typingTimer);
    run.typingTimer = undefined;
  }

  private diagnostics(run: RunState): Record<string, unknown> {
    if (!isLogEnabled("debug")) return {};
    return {
      runElapsedMs: Date.now() - run.startedAt,
      ...run.timeline.diagnostics(),
      deferredTextLen: run.deferredText.length,
      deferredThinkingLen: run.deferredThinking.length,
      finalizedTextLen: run.finalizedText.length,
      resultSentLen: run.resultSentLen,
      thinkingSentLen: run.thinkingSentLen,
      writer: run.writer.stats(),
      budget: this.deps.budget.snapshot(),
    };
  }
}
