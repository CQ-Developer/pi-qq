import { getNextMsgSeq, StreamContentType, StreamInputState } from "@tencent-connect/qqbot-nodejs/protocol";
import type {
  Credentials,
  MessageApi,
  MessageResponse,
  StreamMessageRequest,
} from "@tencent-connect/qqbot-nodejs/protocol";

/**
 * 追加模式（input_mode="append"）的最小流式发送器。
 *
 * SDK 内置 StreamSession 硬编码 input_mode="replace"，2026-10 实测平台返回
 * 「已经提交的消息内容不可修改」拒绝 replace。追加语义下每帧 content_raw
 * 为**新增文本**，与平台"已提交内容不可变"规则一致。
 *
 * 内建两项保护（对齐 SDK StreamSession 的最佳实践）：
 * 1. 节流：token 级增量先入缓冲，按节流窗口（默认 500ms，最小 300ms）合并成帧，
 *    避免高频 message_update 打爆 API。
 * 2. 限流退避：429 / err_code 50002 按指数退避重试（1s→2s→4s，最多 3 次）。
 */

const MIN_INTERVAL_MS = 300;
const RATE_LIMIT_BASE_MS = 1000;
const MAX_RETRIES = 3;

export interface AppendStreamOptions {
  /** 两帧之间的最小间隔；期间增量合并为一帧 */
  throttleMs?: number;
  /** 限流退避基数（ms），测试用 */
  retryBaseMs?: number;
  /** 后台节流 flush 失败回调（此时流已不可信，调用方应标记降级） */
  onError?: (err: Error) => void;
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

  /** 追加增量文本；内部按节流窗口合并成帧，立即返回（后台发送） */
  async append(delta: string): Promise<void> {
    if (this.doneSent || !delta) return;
    this.buffer += delta;
    const elapsed = Date.now() - this.lastFlushAt;
    if (this.flushing) return; // 在途 flush 的 trailing 逻辑会接手缓冲
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

  /** 发送剩余增量并收尾（DONE 帧）。错误向上抛给调用方。 */
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
    await this.doFlush("done"); // DONE 帧 content_raw 为空（已实测接受）
    this.doneSent = true;
  }

  /** 仅停止后台定时器（不发送 DONE；用于会话关闭等异常路径） */
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
    // DONE 帧允许空内容（表示生成结束），generating 无内容则无需发送
    if (!content && state === "generating") return;
    this.flushing = true;
    let failed = false;
    try {
      if (this.msgSeq === null) this.msgSeq = getNextMsgSeq(this.msgId);
      // input_mode 超出 SDK 类型定义（仅 replace），运行时值由平台语义决定
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
      // trailing：flush 期间又有新增量 → 排下一帧
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
        if (attempt >= MAX_RETRIES || !this.isRateLimitError(err)) throw err;
        await new Promise((r) => setTimeout(r, base * 2 ** attempt));
      }
    }
  }

  private isRateLimitError(err: unknown): boolean {
    const e = err as { status?: number; message?: string };
    return e?.status === 429 || /429|50002/.test(String(e?.message ?? ""));
  }
}
