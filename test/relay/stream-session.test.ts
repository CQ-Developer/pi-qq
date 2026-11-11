import { beforeEach, describe, expect, it } from "vitest";
import { AppendStream, type AppendStreamFrameInfo } from "../../src/relay/stream-session";
import { resetMsgSeqAllocator } from "../../src/relay/msg-seq";

beforeEach(() => resetMsgSeqAllocator());

function makeFakeApi() {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    failNext: 0,
    failPlainNext: 0,
    async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
      if (api.failPlainNext > 0) {
        api.failPlainNext -= 1;
        throw new Error("stream broke");
      }
      if (api.failNext > 0) {
        api.failNext -= 1;
        const err = new Error("HTTP 429 rate limited") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      calls.push(req);
      return { id: `sm-${calls.length}` };
    },
  };
  return { api, calls };
}

describe("AppendStream", () => {
  it("节流合帧、内容无损、DONE 正确", async () => {
    const { api, calls } = makeFakeApi();
    const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", {
      throttleMs: 20,
      retryBaseMs: 5,
    });
    const pieces = Array.from({ length: 20 }, (_, i) => `片段${i},`);
    for (const piece of pieces) await stream.append(piece);
    expect(calls.length).toBeLessThanOrEqual(4);
    await stream.done();

    const content = calls.map((call) => call.content_raw as string).join("");
    expect(content).toBe(pieces.join(""));
    expect(calls.at(-1)?.input_state).toBe(10);
    expect(calls.at(-1)?.content_raw).toBe("");
    expect(new Set(calls.map((call) => call.index as number)).size).toBe(calls.length);
  });

  it("限流退避后重试成功且不丢内容", async () => {
    const { api, calls } = makeFakeApi();
    api.failNext = 2;
    const debug: string[] = [];
    const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", {
      throttleMs: 20,
      retryBaseMs: 5,
      onDebug: (message) => debug.push(message),
    });
    await stream.append("限流重试片段");
    await stream.done();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.map((call) => call.content_raw as string).join("")).toBe("限流重试片段");
    expect(debug.length).toBeGreaterThanOrEqual(2);
    expect(debug.join("\n")).toContain("rate limited");
  });

  it("识别 httpStatus/bizCode 限流并在重试时推进 index", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const api = {
      async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
        attempts += 1;
        if (attempts === 1) {
          const err = Object.assign(new Error("rate limited"), { httpStatus: 429, bizCode: 50002 });
          throw err;
        }
        calls.push(req);
        return { id: "sm-retry" };
      },
    };
    const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", {
      throttleMs: 20,
      retryBaseMs: 1,
    });

    await stream.append("retry");
    expect(calls[0]?.index).toBe(1);
    expect(calls[0]?.msg_seq).toEqual(expect.any(Number));
  });

  it("flush 发送缓冲但不结束流", async () => {
    const { api, calls } = makeFakeApi();
    const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", { throttleMs: 300 });
    expect(stream.checkpoint()).toBeNull();
    await stream.append("首帧");
    await stream.append("缓冲内容");
    expect(calls).toHaveLength(1);
    await stream.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.content_raw).toBe("缓冲内容");
    expect(calls[1]?.input_state).toBe(1);
  });

  it("发送失败时 index 与未确认缓冲保留", async () => {
    const { api } = makeFakeApi();
    api.failPlainNext = 1;
    const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", { throttleMs: 300 });
    await expect(stream.append("未确认")).rejects.toThrow("stream broke");
    expect(stream.checkpoint()).toMatchObject({ index: 1, buffer: "未确认" });
  });

  it("失败帧报告结构化诊断信息", async () => {
    const { api } = makeFakeApi();
    api.failPlainNext = 1;
    const frames: Array<{ err: unknown; info: AppendStreamFrameInfo }> = [];
    const stream = new AppendStream(api as never, {} as never, "openid-x", "msg-t", {
      throttleMs: 300,
      onFrameError: (err, info) => frames.push({ err, info }),
    });

    await expect(stream.append("未确认")).rejects.toThrow("stream broke");

    expect(frames).toHaveLength(1);
    expect(frames[0]?.err).toBeInstanceOf(Error);
    expect(frames[0]?.info).toMatchObject({
      index: 0,
      state: "generating",
      msgSeq: expect.any(Number),
      bufferLength: 3,
    });
    expect(frames[0]?.info.streamMsgId).toBeUndefined();
  });

  it("检查点续写沿用 msg_seq 与下一个 index", async () => {
    const { api, calls } = makeFakeApi();
    const first = new AppendStream(api as never, {} as never, "openid-x", "msg-t", { throttleMs: 300 });
    await first.append("前半");
    await first.flush();
    const checkpoint = first.checkpoint();
    expect(checkpoint).toEqual({ msgSeq: calls[0]?.msg_seq, index: 1, streamMsgId: "sm-1" });
    first.dispose();

    const second = new AppendStream(api as never, {} as never, "openid-x", "msg-t", {
      throttleMs: 300,
      resume: checkpoint ?? undefined,
    });
    await second.append("后半");
    await second.done();

    expect(calls.map((call) => call.content_raw as string).join("")).toBe("前半后半");
    expect(calls[1]?.msg_seq).toBe(calls[0]?.msg_seq);
    expect(calls[1]?.index).toBe(1);
    expect(calls[1]?.stream_msg_id).toBe("sm-1");
    expect(calls.at(-1)?.input_state).toBe(10);
  });
});
