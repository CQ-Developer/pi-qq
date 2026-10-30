import { getNextMsgSeq, StreamContentType, StreamInputState } from "@tencent-connect/qqbot-nodejs/protocol";
import type {
  Credentials,
  MessageApi,
  MessageResponse,
  StreamMessageRequest,
} from "@tencent-connect/qqbot-nodejs/protocol";

/**
 * Minimal append-mode (input_mode="append") stream sender.
 *
 * The SDK StreamSession hardcodes input_mode="replace"; in 2026-10 the platform
 * rejected it with "submitted message content cannot be modified". In append mode
 * each content_raw frame carries only the **new** text, matching the platform rule
 * that already-submitted content is immutable.
 *
 * Two built-in safeguards (aligned with SDK StreamSession best practices):
 * 1. Throttle: token increments are buffered and merged into frames per throttle
 *    window (default 500ms, minimum 300ms) to avoid flooding the API.
 * 2. Rate-limit backoff: 429 / err_code 50002 retry exponentially (1s→2s→4s, max 3).
 */

const MIN_INTERVAL_MS = 300;
const RATE_LIMIT_BASE_MS = 1000;
const MAX_RETRIES = 3;

export interface AppendStreamOptions {
  /** Minimum interval between frames; increments are merged during the window. */
  throttleMs?: number;
  /** Rate-limit backoff base in ms (for tests). */
  retryBaseMs?: number;
  /** Background throttle flush failure (stream is no longer trusted). */
  onError?: (err: Error) => void;
  /** Diagnostic log via the shared logger: rate-limit retries/final failures. */
  onDebug?: (message: string) => void;
}

export class AppendStream {
  private index = 0;
  private msgSeq: number | null = null;
  private streamMsgId: string | undefined;
  private doneSent = false;
  private buffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private lastFlushAt = 0;

  constructor(
    private readonly api: MessageApi,
    private readonly creds: Credentials,
    private readonly openid: string,
    private readonly msgId: string,
    private readonly opts: AppendStreamOptions = {},
  ) {}

  private throttleMs(): number {
    return Math.max(this.opts.throttleMs ?? 500, MIN_INTERVAL_MS);
  }

  /** Append text; frames are merged by throttle window and sent in the background. */
  async append(delta: string): Promise<void> {
    if (this.doneSent || !delta) return;
    this.buffer += delta;
    const elapsed = Date.now() - this.lastFlushAt;
    if (this.flushing) return; // The in-flight flush trailing logic will pick up the buffer.
    if (elapsed >= this.throttleMs()) {
      await this.doFlush("generating");
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.doFlush("generating").catch((err) => this.opts.onError?.(err as Error));
      }, this.throttleMs() - elapsed);
    }
  }

  /** Flush remaining text and send DONE. Errors propagate to the caller. */
  async done(): Promise<void> {
    if (this.doneSent) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.buffer) await this.doFlush("generating");
    await this.doFlush("done"); // DONE frames carry empty content_raw (verified).
    this.doneSent = true;
  }

  /** Stop background timers only; no DONE (for shutdown/error paths). */
  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.doneSent = true;
  }

  private async doFlush(state: "generating" | "done"): Promise<void> {
    if (this.flushing) return;
    const content = state === "done" ? "" : this.buffer;
    // DONE frames may be empty (generation finished); empty generating frames are skipped.
    if (!content && state === "generating") return;
    this.flushing = true;
    let failed = false;
    try {
      if (this.msgSeq === null) this.msgSeq = getNextMsgSeq(this.msgId);
      // input_mode is outside the SDK type (replace only); the platform defines its runtime meaning.
      const req = {
        input_mode: "append",
        input_state: state === "done" ? StreamInputState.DONE : StreamInputState.GENERATING,
        content_type: StreamContentType.MARKDOWN,
        content_raw: content,
        event_id: this.msgId,
        msg_id: this.msgId,
        msg_seq: this.msgSeq,
        index: this.index++,
        ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      } as unknown as StreamMessageRequest;
      const resp = await this.sendWithRetry(req);
      if (resp?.id && !this.streamMsgId) this.streamMsgId = resp.id;
      if (state === "generating") this.buffer = "";
      this.lastFlushAt = Date.now();
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      this.flushing = false;
      // Trailing: new data arrived during flush; schedule the next frame.
      if (!failed && state === "generating" && this.buffer && !this.doneSent && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.doFlush("generating").catch((err) => this.opts.onError?.(err as Error));
        }, this.throttleMs());
      }
    }
  }

  private async sendWithRetry(req: StreamMessageRequest): Promise<MessageResponse | undefined> {
    const base = this.opts.retryBaseMs ?? RATE_LIMIT_BASE_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.api.sendC2CStreamMessage(this.creds, this.openid, req);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (attempt >= MAX_RETRIES || !this.isRateLimitError(err)) {
          this.opts.onDebug?.(`frame index=${req.index} failed after ${attempt + 1} attempt(s): ${reason}`);
          throw err;
        }
        const delay = base * 2 ** attempt;
        this.opts.onDebug?.(
          `frame index=${req.index} rate limited (attempt ${attempt + 1}), retry in ${delay}ms: ${reason}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private isRateLimitError(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    return e?.status === 429 || /429|50002/.test(String(e?.message ?? ""));
  }
}
