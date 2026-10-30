import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeQQBot {
    static last: FakeQQBot | undefined;
    handlers = new Map<string, (ctx: unknown, msg: unknown) => unknown>();

    constructor() {
      FakeQQBot.last = this;
    }

    use(): this {
      return this;
    }

    on(event: string, handler: (ctx: unknown, msg: unknown) => unknown): void {
      this.handlers.set(event, handler);
    }

    async start(): Promise<void> {}

    stop(): void {}
  }
  return { FakeQQBot };
});

vi.mock("@tencent-connect/qqbot-nodejs", () => ({
  QQBot: mocks.FakeQQBot,
  GatewayErrorCode: { FATAL_CLOSE: "fatal", RETRY_EXHAUSTED: "retry" },
  accessPolicy: () => async (_ctx: unknown, next: () => Promise<void>) => next(),
  concurrencyGuard: () => async (_ctx: unknown, next: () => Promise<void>) => next(),
  contentSanitizer: () => async (_ctx: unknown, next: () => Promise<void>) => next(),
  messageFilter: () => async (_ctx: unknown, next: () => Promise<void>) => next(),
}));

import { startBot } from "../src/bot";

describe("bot message handler", () => {
  it("awaits onMessage so the SDK concurrency guard holds its lock", async () => {
    let release!: () => void;
    const onMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    startBot({ credentials: { appId: "app", appSecret: "secret" }, onMessage });
    const handler = mocks.FakeQQBot.last?.handlers.get("message");
    expect(handler).toBeDefined();

    let settled = false;
    const pending = handler!({}, { kind: "c2c" }) as Promise<void>;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await pending;
    expect(settled).toBe(true);
  });
});
