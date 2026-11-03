import { getNextMsgSeq, StreamContentType, StreamInputState } from "@tencent-connect/qqbot-nodejs/protocol";
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
  msgSeq: number;
  index: number;
  streamMsgId?: string;
  buffer?: string;
}

export interface AppendStreamOptions {
  throttleMs?: number;
  retryBaseMs?: number;
  resume?: AppendStreamCheckpoint;
  onError?: (err: Error) => void;
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
  ) {
    const resume = this.opts.resume;
    if (resume) {
      this.msgSeq = resume.msgSeq;
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
    if (this.flushing) return;
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
      const resp = await this.sendWithRetry(req);
      if (resp?.id && !this.streamMsgId) this.streamMsgId = resp.id;
      if (state === "generating") this.buffer = this.buffer.slice(content.length);
      this.lastFlushAt = Date.now();
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
