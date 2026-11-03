import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => {
  const stop = vi.fn();
  return {
    stop,
    startQrConnect: vi.fn((handlers: { onFailure: (err: Error) => void }, options: { signal: AbortSignal }) => {
      const fail = () => handlers.onFailure(new Error("已取消"));
      options.signal.addEventListener("abort", fail);
      return stop;
    }),
  };
});

vi.mock("@tencent-connect/qqbot-connector", () => ({
  startQrConnect: mocks.startQrConnect,
}));

import { runQrLogin } from "../../src/qq/qr-login";

describe("runQrLogin", () => {
  it("does not report an error when the overlay is cancelled", async () => {
    const notify = vi.fn();
    let component: { handleInput(data: string): void } | undefined;

    const ctx = {
      mode: "tui",
      ui: {
        notify,
        custom: (factory: (...args: unknown[]) => { handleInput(data: string): void }) => {
          component = factory(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text },
            { matches: () => false },
            vi.fn(),
          );
          return Promise.resolve();
        },
      },
    } as unknown as ExtensionContext;

    const pending = runQrLogin(ctx);
    expect(component).toBeDefined();
    component!.handleInput("\x1b");

    await expect(pending).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalledWith("Error: QR login failed", "error");
    expect(mocks.stop).toHaveBeenCalled();
  });
});
