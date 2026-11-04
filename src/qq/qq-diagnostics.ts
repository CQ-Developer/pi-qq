import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReplyBudget } from "../quota/reply-quota";
import { formatBudgetStatus } from "../quota/reply-quota-report";
import { AppendStream } from "../relay/stream-session";
import type { RunningBot } from "./qq-bot";
import { t } from "../infra/i18n";
import { thinkingHeader } from "../relay/stream-block-format";

export interface QQDiagnosticsDeps {
  getRunning: () => RunningBot | undefined;
  budget: ReplyBudget;
  getBoundOpenid: () => string | undefined;
}

export function registerQQDiagnostics(pi: ExtensionAPI, deps: QQDiagnosticsDeps): void {
  const diagTarget = () => {
    const last = deps.budget.lastTarget;
    if (last) return { scope: "c2c" as const, targetId: last.openid, msgId: last.msgId };
    const bound = deps.getBoundOpenid();
    return bound ? { scope: "c2c" as const, targetId: bound } : undefined;
  };

  pi.registerCommand("qq-test-budget", {
    description: t("diagnostics.descBudget"),
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatBudgetStatus(deps.budget.snapshot(), deps.budget.lastTarget).join("\n"), "info");
    },
  });

  pi.registerCommand("qq-test-md", {
    description: t("diagnostics.descMd"),
    handler: async (args, ctx) => {
      const running = deps.getRunning();
      if (!running) {
        ctx.ui.notify(t("diagnostics.notConnected"), "warning");
        return;
      }
      const target = diagTarget();
      if (!target) {
        ctx.ui.notify(t("diagnostics.noTarget"), "warning");
        return;
      }
      const content = args?.trim() || "**Markdown test**\n# Heading\n- Item one\n- Item two\n[Link](https://qq.com)";
      try {
        await running.bot.sendMarkdown(target, content);
        ctx.ui.notify(t("diagnostics.mdSent"), "info");
      } catch (err) {
        ctx.ui.notify(t("diagnostics.mdFailed", { message: (err as Error).message }), "error");
      }
    },
  });

  pi.registerCommand("qq-test-stream", {
    description: t("diagnostics.descStream"),
    handler: async (args, ctx) => {
      const running = deps.getRunning();
      if (!running) {
        ctx.ui.notify(t("diagnostics.notConnected"), "warning");
        return;
      }
      const last = deps.budget.lastTarget;
      if (!last) {
        ctx.ui.notify(t("diagnostics.streamNoTarget"), "warning");
        return;
      }

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let stream: AppendStream | undefined;
      try {
        if (args?.trim() === "resume") {
          const first = new AppendStream(running.bot.messageApi, running.bot.getCredentials(), last.openid, last.msgId);
          stream = first;
          await first.append(t("diagnostics.probeResumeFrame1"));
          await first.flush();
          const checkpoint = first.checkpoint();
          first.dispose();
          stream = undefined;
          if (!checkpoint?.streamMsgId) {
            ctx.ui.notify(t("diagnostics.resumeNoStream"), "error");
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
          await second.append(t("diagnostics.probeResumeFrame2"));
          await second.done();
          second.dispose();
          stream = undefined;
          ctx.ui.notify(
            t("diagnostics.resumeResult", {
              index: checkpoint.index,
              streamMsgId: checkpoint.streamMsgId,
            }),
            "info",
          );
          return;
        }

        stream = new AppendStream(running.bot.messageApi, running.bot.getCredentials(), last.openid, last.msgId);
        await stream.append(
          `${thinkingHeader()}${t("diagnostics.probeThinking")}\n\n## 💻 bash\n\n\`\`\`bash\necho probe\n\`\`\`\n\n\`\`\`text\n${t("diagnostics.probeCode")}\n\`\`\`\n`,
        );
        await sleep(1200);
        await stream.append(`\n${t("diagnostics.probeIntermediate")}\n`);
        await sleep(1200);
        await stream.append(
          `\n## 📖 read\n\n\`src/index.ts\`\n\n\`\`\`typescript\n${t("diagnostics.probeReadFile")}\n\`\`\`\n`,
        );
        await sleep(800);
        await stream.append(`\n${t("diagnostics.probeFinal")}`);
        let doneNote = t("diagnostics.doneSucceeded");
        try {
          await stream.done();
        } catch (doneErr) {
          doneNote = t("diagnostics.doneRejected", { message: (doneErr as Error).message });
        }
        stream.dispose();
        stream = undefined;
        ctx.ui.notify(t("diagnostics.streamResult", { done: doneNote }), "info");
      } catch (err) {
        stream?.dispose();
        ctx.ui.notify(t("diagnostics.streamFailed", { message: (err as Error).message }), "error");
      }
    },
  });
}
