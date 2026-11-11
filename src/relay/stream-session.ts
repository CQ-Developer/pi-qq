import { getNextMsgSeq, StreamContentType, StreamInputState } from "@tencent-connect/qqbot-nodejs/protocol";
import { translate } from "../infra/i18n";
import type {
  Credentials,
  MessageApi,
  MessageResponse,
  StreamMessageRequest,
} from "@tencent-connect/qqbot-nodejs/protocol";

const MIN_INTERVAL_MS = 300;
const RATE_LIMIT_BASE_MS = 1000;
const MAX_RETRIES = 3;

export interface AppendStreamCheckpoint {
  msgSeq?: number;
  index: number;
  streamMsgId?: string;
  buffer?: string;
}

export interface AppendStreamFrameInfo {
  index: number;
  state: "generating" | "done";
  msgSeq: number | null;
  streamMsgId?: string;
  bufferLength: number;
}

interface AppendStreamOptions {
  throttleMs?: number;
  retryBaseMs?: number;
  resume?: AppendStreamCheckpoint;
  onError?: (err: Error) => void;
  onDebug?: (message: string) => void;
  onFrameError?: (err: unknown, info: AppendStreamFrameInfo) => void;
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
  ) {
    const resume = this.opts.resume;
    if (resume) {
      if (resume.msgSeq !== undefined) this.msgSeq = resume.msgSeq;
      this.index = resume.index;
      this.streamMsgId = resume.streamMsgId;
      this.buffer = resume.buffer ?? "";
    }
  }

  checkpoint(): AppendStreamCheckpoint | null {
    if (this.msgSeq === null) return null;
    return {
      msgSeq: this.msgSeq,
      index: this.index,
      streamMsgId: this.streamMsgId,
      ...(this.buffer ? { buffer: this.buffer } : {}),
    };
  }

  async flush(): Promise<void> {
    if (this.doneSent) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.doneSent) return;
    if (this.buffer) await this.doFlush("generating");
  }

  private throttleMs(): number {
    return Math.max(this.opts.throttleMs ?? 500, MIN_INTERVAL_MS);
  }

  async append(delta: string): Promise<void> {
    if (this.doneSent || !delta) return;
    this.buffer += delta;
    const elapsed = Date.now() - this.lastFlushAt;
    const throttle = this.throttleMs();
    if (this.flushing) {
      this.opts.onDebug?.(`append: while flushing, buffer=${this.buffer.length}`);
      return;
    }
    if (elapsed >= throttle) {
      this.opts.onDebug?.(`append: immediate, elapsed=${elapsed}, buffer=${this.buffer.length}`);
      await this.doFlush("generating");
      return;
    }
    if (!this.flushTimer) {
      const waitMs = throttle - elapsed;
      this.opts.onDebug?.(`append: buffered, elapsed=${elapsed}, wait=${waitMs}, buffer=${this.buffer.length}`);
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.opts.onDebug?.(`timer: fired after ${waitMs}, buffer=${this.buffer.length}`);
        void this.doFlush("generating").catch((err) => this.opts.onError?.(err as Error));
      }, waitMs);
    }
  }

  async done(): Promise<void> {
    if (this.doneSent) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.doneSent) return;
    if (this.buffer) await this.doFlush("generating");
    await this.doFlush("done");
    this.doneSent = true;
  }

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
    if (!content && state === "generating") return;
    this.opts.onDebug?.(
      `flush: start state=${state}, content=${content.length}, index=${this.index}, msgSeq=${this.msgSeq ?? "none"}, streamMsgId=${this.streamMsgId ?? "none"}`,
    );
    this.flushing = true;
    let failed = false;
    try {
      if (this.msgSeq === null) this.msgSeq = getNextMsgSeq(this.msgId);
      const index = this.index++;
      const req = {
        input_mode: "append",
        input_state: state === "done" ? StreamInputState.DONE : StreamInputState.GENERATING,
        content_type: StreamContentType.MARKDOWN,
        content_raw: content,
        event_id: this.msgId,
        msg_id: this.msgId,
        msg_seq: this.msgSeq,
        index,
        ...(this.streamMsgId ? { stream_msg_id: this.streamMsgId } : {}),
      } as unknown as StreamMessageRequest;
      const resp = await this.sendWithRetry(req, state);
      if (resp?.id && !this.streamMsgId) this.streamMsgId = resp.id;
      if (state === "generating") this.buffer = this.buffer.slice(content.length);
      this.lastFlushAt = Date.now();
      this.opts.onDebug?.(
        `flush: done state=${state}, remaining=${this.buffer.length}, streamMsgId=${this.streamMsgId ?? "none"}`,
      );
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      this.flushing = false;
      if (!failed && state === "generating" && this.buffer && !this.doneSent && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.doFlush("generating").catch((err) => this.opts.onError?.(err as Error));
        }, this.throttleMs());
      }
    }
  }

  private async sendWithRetry(
    req: StreamMessageRequest,
    state: "generating" | "done",
  ): Promise<MessageResponse | undefined> {
    const base = this.opts.retryBaseMs ?? RATE_LIMIT_BASE_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.api.sendC2CStreamMessage(this.creds, this.openid, req);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (attempt >= MAX_RETRIES || !this.isRateLimitError(err)) {
          this.opts.onFrameError?.(err, {
            index: req.index,
            state,
            msgSeq: this.msgSeq,
            ...(this.streamMsgId ? { streamMsgId: this.streamMsgId } : {}),
            bufferLength: this.buffer.length,
          });
          this.opts.onDebug?.(
            translate("en-us", "log.streamFrameFailed", { index: req.index, attempts: attempt + 1, reason }),
          );
          throw err;
        }
        const delay = base * 2 ** attempt;
        this.opts.onDebug?.(
          translate("en-us", "log.streamFrameRateLimited", { index: req.index, attempt: attempt + 1, delay, reason }),
        );
        await new Promise((r) => setTimeout(r, delay));
        req.index = this.index++;
      }
    }
  }

  private isRateLimitError(err: unknown): boolean {
    const e = err as {
      status?: number;
      httpStatus?: number;
      code?: number;
      err_code?: number;
      bizCode?: number;
      message?: string;
    };
    return (
      e?.status === 429 ||
      e?.httpStatus === 429 ||
      e?.code === 429 ||
      e?.code === 50002 ||
      e?.err_code === 50002 ||
      e?.bizCode === 50002 ||
      /429|50002/.test(String(e?.message ?? ""))
    );
  }
}
