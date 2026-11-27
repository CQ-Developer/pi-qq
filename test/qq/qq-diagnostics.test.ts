import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureI18n } from "../../src/infra/i18n";
import { ReplyBudget } from "../../src/quota/reply-quota";
import { registerQQDiagnostics } from "../../src/qq/qq-diagnostics";

beforeEach(() => configureI18n("en-us"));

function makeCommands() {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

describe("qq diagnostics budget accounting", () => {
  it("records a successful Markdown probe as a passive reply", async () => {
    const { pi, commands } = makeCommands();
    const budget = new ReplyBudget();
    budget.observeInbound("openid-u", "msg-1");
    const send = vi.fn(async () => ({ id: "reply-1" }));
    const bot = {
      send,
      messageApi: {},
      getCredentials: () => ({}),
    };
    registerQQDiagnostics(pi, {
      getRunning: () => ({ bot: bot as never, stop: () => {} }),
      budget,
      getBoundOpenid: () => "openid-u",
    });

    await commands.get("qq-test-md")!("", { ui: { notify: vi.fn() } });

    expect(send).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().remaining).toBe(3);
  });
});
