import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The slice of ExtensionContext used by QQ inbound handling. */
export interface InboundContext {
  readonly cwd: string;
  isIdle(): boolean;
  abort(): void;
  compact(): void;
  sessionManager: { getSessionId(): string };
}

export type InboundPi = Pick<ExtensionAPI, "sendUserMessage">;

export interface InboundCommandDeps {
  pi: InboundPi;
  ctx: InboundContext;
  getStatusLines: () => string[];
  onStop?: () => void;
  waitForEnd?: () => Promise<void>;
}

export async function handleInboundCommand(
  text: string,
  reply: (t: string) => Promise<void>,
  deps: InboundCommandDeps,
): Promise<void> {
  const cmd = text.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      await reply(
        [
          "pi-qq commands:",
          "• /stop — abort the current task",
          "• /compact — compact the context",
          "• /status — show status",
          "• /new — reset the session",
          "• /help — this help",
          "Other text is sent to pi.",
        ].join("\n"),
      );
      break;
    case "/stop":
      deps.onStop?.();
      if (deps.ctx.isIdle()) {
        await reply("No task is running.");
      } else {
        deps.ctx.abort();
        await deps.waitForEnd?.();
        await reply("Abort requested.");
      }
      break;
    case "/compact":
      if (deps.ctx.isIdle()) {
        deps.ctx.compact();
        await reply("Context compaction triggered.");
      } else {
        await reply("Task is running; use /stop before /compact.");
      }
      break;
    case "/status":
      await reply(deps.getStatusLines().join("\n"));
      break;
    case "/new":
      if (!deps.ctx.isIdle()) {
        await reply("Task is running; use /stop before resetting.");
      } else {
        await reply("Resetting the session…");
        deps.pi.sendUserMessage("/qq-new", { expandPromptTemplates: true });
      }
      break;
    default:
      await reply(`Unknown command ${cmd}; use /help.`);
  }
}
