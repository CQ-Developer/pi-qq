import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { log } from "../infra/file-logger";
import { t } from "../infra/i18n";

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
  getLastMessage?: () => string | undefined;
  onStop?: () => void;
  waitForEnd?: () => Promise<void>;
}

export interface InboundCommandExtras {
  streamReply?: (text: string) => Promise<void>;
  restartPush?: () => void;
}

export async function handleInboundCommand(
  text: string,
  reply: (t: string) => Promise<void>,
  deps: InboundCommandDeps,
  extras: InboundCommandExtras = {},
): Promise<void> {
  const cmd = text.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      await reply(
        [
          t("commands.help.title"),
          t("commands.help.stop"),
          t("commands.help.compact"),
          t("commands.help.status"),
          t("commands.help.last"),
          t("commands.help.new"),
          t("commands.help.help"),
          t("commands.help.other"),
        ].join("\n"),
      );
      break;
    case "/stop":
      deps.onStop?.();
      if (deps.ctx.isIdle()) {
        await reply(t("commands.stop.none"));
      } else {
        deps.ctx.abort();
        const waitStartedAt = Date.now();
        log.debug("inbound", "stream timing", { phase: "/stop wait start" });
        await deps.waitForEnd?.();
        log.debug("inbound", "stream timing", {
          phase: "/stop wait done",
          waitedMs: Date.now() - waitStartedAt,
        });
        await reply(t("commands.stop.abort"));
      }
      break;
    case "/compact":
      if (deps.ctx.isIdle()) {
        deps.ctx.compact();
        await reply(t("commands.compact.done"));
      } else {
        await reply(t("commands.compact.busy"));
      }
      break;
    case "/status":
      await reply(deps.getStatusLines().join("\n"));
      break;
    case "/last": {
      if (!deps.ctx.isIdle()) {
        extras.restartPush?.();
      } else {
        const text = deps.getLastMessage?.();
        if (text) {
          if (extras.streamReply) {
            await extras.streamReply(text);
          } else {
            await reply(text);
          }
        } else {
          await reply(t("commands.last.none"));
        }
      }
      break;
    }
    case "/new":
      if (!deps.ctx.isIdle()) {
        await reply(t("commands.new.busy"));
      } else {
        await reply(t("commands.new.resetting"));
        deps.pi.sendUserMessage("/qq-new", { expandPromptTemplates: true });
      }
      break;
    default:
      await reply(t("commands.unknown", { cmd }));
  }
}
