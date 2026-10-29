import { describe, expect, it } from "vitest";
import { AppendStream } from "../src/append-stream";

function makeFakeApi() {
  const calls: Array<Record<string, unknown>> = [];
  const api = {
    failNext: 0,
    async sendC2CStreamMessage(_creds: unknown, _openid: unknown, req: Record<string, unknown>) {
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
});
