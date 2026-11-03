import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReplyBudget } from "../quota/reply-quota";
import { formatBudgetStatus } from "../quota/reply-quota-report";
import { AppendStream } from "../relay/stream-session";
import type { RunningBot } from "./qq-bot";

export interface QQDiagnosticsDeps {
  getRunning: () => RunningBot | undefined;
  budget: ReplyBudget;
  getBoundOpenid: () => string | undefined;
}

/**
 * Terminal-only protocol probes. Kept out of the entrypoint so index.ts stays
 * a composition root and does not construct stream frames directly.
 */
export function registerQQDiagnostics(pi: ExtensionAPI, deps: QQDiagnosticsDeps): void {
  const diagTarget = () => {
    const last = deps.budget.lastTarget;
    if (last) return { scope: "c2c" as const, targetId: last.openid, msgId: last.msgId };
    const bound = deps.getBoundOpenid();
    return bound ? { scope: "c2c" as const, targetId: bound } : undefined;
  };

  pi.registerCommand("qq-test-budget", {
    description: "pi-qq: show passive reply budget, stream bubbles, and last inbound target",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatBudgetStatus(deps.budget.snapshot(), deps.budget.lastTarget).join("\n"), "info");
    },
  });

  pi.registerCommand("qq-test-md", {
    description: "pi-qq: send a Markdown message to verify QQ C2C Markdown rendering",
    handler: async (args, ctx) => {
      const running = deps.getRunning();
      if (!running) {
        ctx.ui.notify("pi-qq is not connected.", "warning");
        return;
      }
      const target = diagTarget();
      if (!target) {
        ctx.ui.notify("pi-qq: no send target. Send a QQ message first.", "warning");
        return;
      }
      const content = args?.trim() || "**Markdown test**\n# Heading\n- Item one\n- Item two\n[Link](https://qq.com)";
      try {
        await running.bot.sendMarkdown(target, content);
        ctx.ui.notify("Markdown test sent. Check whether QQ renders it as rich text.", "info");
      } catch (err) {
        ctx.ui.notify(`Markdown send failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("qq-test-stream", {
    description: "pi-qq: run a streamed timeline diagnostic (thinking/tools/text) or resume probe",
    handler: async (args, ctx) => {
      const running = deps.getRunning();
      if (!running) {
        ctx.ui.notify("pi-qq is not connected.", "warning");
        return;
      }
      const last = deps.budget.lastTarget;
      if (!last) {
        ctx.ui.notify("pi-qq: send a QQ message first (streaming needs a msgId).", "warning");
        return;
      }

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let stream: AppendStream | undefined;
      try {
        if (args?.trim() === "resume") {
          const first = new AppendStream(running.bot.messageApi, running.bot.getCredentials(), last.openid, last.msgId);
          stream = first;
          await first.append("**Resume probe** frame 1\n");
          await first.flush();
          const checkpoint = first.checkpoint();
          first.dispose();
          stream = undefined;
          if (!checkpoint?.streamMsgId) {
            ctx.ui.notify("Resume probe: frame 1 sent but stream_msg_id is missing; cannot resume.", "error");
            return;
          }
          await sleep(800);
          const second = new AppendStream(
            running.bot.messageApi,
            running.bot.getCredentials(),
            last.openid,
            last.msgId,
            { resume: checkpoint },
          );
          stream = second;
          await second.append("frame 2 after resume\n");
          await second.done();
          second.dispose();
          stream = undefined;
          ctx.ui.notify(
            `Resume probe: frame 2 sent with index ${checkpoint.index} and stream_msg_id ${checkpoint.streamMsgId}. Check whether both frames are in the same bubble.`,
            "info",
          );
          return;
        }

        stream = new AppendStream(running.bot.messageApi, running.bot.getCredentials(), last.openid, last.msgId);
        await stream.append(
          "**💭 思考**\n\nprobe thinking\nsecond line\n\n**💻 bash**\n\n`echo probe`\n\n```text\nprobe\n```\n",
        );
        await sleep(1200);
        await stream.append("\n**Intermediate message**: first-turn reply.\n");
        await sleep(1200);
        await stream.append("\n**📖 read**\n\n`src/index.ts`\n\n```text\nprobe file\n```\n");
        await sleep(800);
        await stream.append("\n**Final reply** (streamed append)");
        let doneNote = "DONE succeeded";
        try {
          await stream.done();
        } catch (doneErr) {
          doneNote = `DONE rejected: ${(doneErr as Error).message}`;
        }
        stream.dispose();
        stream = undefined;
        ctx.ui.notify(`Stream timeline test: frames sent, ${doneNote}. Check the QQ activity timeline.`, "info");
      } catch (err) {
        stream?.dispose();
        ctx.ui.notify(`Stream timeline test failed: ${(err as Error).message}`, "error");
      }
    },
  });
}
