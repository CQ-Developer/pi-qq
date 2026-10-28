import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearCredentials,
  getCredentials,
  getSettings,
  readConfig,
  saveCredentials,
  type Credentials,
  type PiQQConfig,
} from "./src/config";
import { startBot, type BotState, type RunningBot } from "./src/bot";
import { runQrLogin } from "./src/login";
import { createInboundHandler } from "./src/inbound";
import { markdownToPlain, sendReply } from "./src/outbound";
import { ReplyBudget } from "./src/reply-budget";
import { RunFeedback } from "./src/run-feedback";
import { AppendStream } from "./src/append-stream";

/**
 * pi-qq 扩展入口：
 * - M1：登录接入（配置直连 / 扫码）、/qq-login /qq-status /qq-logout、生命周期
 * - M2：QQ 单人聊天注入 pi（inbound）+ assistant 消息非流式回传（message_end）
 */

/** 会话级状态；reload/会话切换后由新 runtime 重建 */
let running: RunningBot | undefined;
let lastState: BotState = "stopped";
let stateDetail: string | undefined;
let sessionCtx: ExtensionContext | undefined;
const budget = new ReplyBudget();
const runFeedback = new RunFeedback({
  bot: () => running?.bot,
  budget,
  boundOpenid: () => readConfig().config.allowedOpenid,
  getHeartbeatMinutes: () => getSettings(readConfig().config).heartbeatMinutes,
  getHeartbeatMaxMessages: () => getSettings(readConfig().config).heartbeatMaxMessages,
  getStreamRelay: () => getSettings(readConfig().config).streamRelay,
  makeChannel: () => ({
    budget,
    boundOpenid: readConfig().config.allowedOpenid ?? "",
    onWarn: (msg) => sessionCtx?.ui.notify(`pi-qq ${msg}`, "warning"),
  }),
  onWarn: (msg) => sessionCtx?.ui.notify(`pi-qq ${msg}`, "warning"),
});

const fmtTokens = (n: number | null): string =>
  n === null ? "未知" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export default function (pi: ExtensionAPI) {
  const maskAppId = (appId: string) => `${appId.slice(0, 4)}****`;

  // —— 实时配置读取器（绑定/设置变更即时生效）——

  const getAllowedOpenid = () => readConfig().config.allowedOpenid;
  const getBoundOpenid = getAllowedOpenid;
  const getDeliverAs = () => getSettings(readConfig().config).deliverAs;

  const onWarn = (ctx: ExtensionContext) => (msg: string) =>
    ctx.ui.notify(`pi-qq ${msg}`, "warning");

  const getStatusLines = (): string[] => {
    const { config } = readConfig();
    const usage = sessionCtx?.getContextUsage();
    const model = sessionCtx?.model;
    return [
      "pi-qq 状态",
      `连接：${lastState}${stateDetail ? `（${stateDetail}）` : ""}`,
      `模型：${model?.name ?? "未选择"}`,
      usage
        ? `上下文：${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}（${usage.percent?.toFixed(1) ?? "?"}%）`
        : "上下文：未知",
      `绑定用户：${config.allowedOpenid ?? "未绑定（首个私聊用户将自动绑定）"}`,
    ];
  };

  // —— 登录与连接（M1）——

  const startWithCredentials = (ctx: ExtensionContext, creds: Credentials, config: PiQQConfig, source: string) => {
    running?.stop();
    stateDetail = undefined;
    sessionCtx = ctx;
    running = startBot({
      credentials: creds,
      allowedOpenid: config.allowedOpenid,
      markdownSupport: config.markdownSupport,
      onMessage: createInboundHandler({
        pi,
        ctx,
        budget,
        getAllowedOpenid,
        getBoundOpenid,
        getDeliverAs,
        getStatusLines,
        onWarn: onWarn(ctx),
        markQQTrigger: (openid, msgId) => runFeedback.markQQTrigger(openid, msgId),
      }),
      onStateChange: (state, detail) => {
        lastState = state;
        stateDetail = detail;
        // 只对用户需要知道的状态发通知；reconnecting 高频且 SDK 会自愈，不打扰
        if (state === "connected") ctx.ui.notify(`pi-qq 已连接（${source}）`, "info");
        else if (state === "blocked") ctx.ui.notify(`pi-qq ${detail ?? "连接被致命关闭"}`, "error");
        else if (state === "stopped" && detail) ctx.ui.notify(`pi-qq ${detail}`, "warning");
      },
      onRecoverableError: () => {
        // 可恢复错误由 SDK 自动重连；长时间故障约每分钟一次，M1 不告警
      },
    });
  };

  const stopIfRunning = () => {
    running?.stop();
    running = undefined;
    lastState = "stopped";
  };

  // —— 生命周期 ——

  pi.on("session_start", (_event, ctx) => {
    const { config, error } = readConfig();
    if (error) {
      ctx.ui.notify(`pi-qq ${error}`, "error");
      return;
    }
    const creds = getCredentials(config);
    if (creds) {
      startWithCredentials(ctx, creds, config, "配置直连");
    } else if (ctx.hasUI) {
      ctx.ui.notify(
        "pi-qq 未配置机器人凭据：执行 /qq-login 扫码登录，或在 ~/.pi/agent/pi-qq.json 写入 { AppID, AppSecret } 后重启会话",
        "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    stopIfRunning();
    sessionCtx = undefined;
    runFeedback.dispose();
  });

  // —— F7 run 级反馈：agent 生命周期 / 工具计数 / 文本流式 ——

  pi.on("agent_start", () => {
    runFeedback.onAgentStart();
  });

  pi.on("agent_end", () => {
    void runFeedback.onAgentEnd();
  });

  pi.on("tool_execution_start", (event) => {
    void runFeedback.onToolStart(event.toolName);
  });

  pi.on("tool_execution_end", (event) => {
    runFeedback.onToolEnd(event.toolName, event.isError);
  });

  pi.on("message_update", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    const snapshot = msg.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const thinking = msg.content
      .filter((b) => b.type === "thinking")
      .map((b) => b.thinking)
      .join("");
    void runFeedback.onAssistantDelta(snapshot, thinking);
  });

  // —— pi → QQ：assistant 消息回传（非流式路径 + F7 流接管）——

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant" || !running) return;

    const { config } = readConfig();
    const settings = getSettings(config);
    const isError = msg.stopReason === "error";

    let text: string;
    if (isError) {
      text = `⚠️ 模型调用失败：${msg.errorMessage ?? "未知错误"}`;
    } else {
      text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    if (!text) return;

    // markdownSupport=true 时透传原始 Markdown（sendMarkdown 卡片在 M4 打磨）
    const payload = settings.markdownSupport ? text : markdownToPlain(text);

    // F7：流接管（含机会性尝试）→ 跳过普通发送，避免双发；agent_end 时 complete()
    if (await runFeedback.onAssistantFinal(payload, isError)) return;

    const bound = config.allowedOpenid;
    if (!bound) {
      ctx.ui.notify("pi-qq：未绑定用户，跳过回传", "warning");
      return;
    }

    void sendReply(running.bot, payload, {
      budget,
      boundOpenid: bound,
      onWarn: onWarn(ctx),
    });
  });

  // —— 命令（M1）——

  pi.registerCommand("qq-login", {
    description: "pi-qq：扫码登录/换绑 QQ 机器人（凭据写入 ~/.pi/agent/pi-qq.json）",
    handler: async (_args, ctx) => {
      const { config, error } = readConfig();
      if (error) {
        ctx.ui.notify(`pi-qq ${error}`, "error");
        return;
      }
      if (getCredentials(config) && running) {
        stopIfRunning();
        ctx.ui.notify("已断开当前连接，开始扫码换绑…", "info");
      }
      const creds = await runQrLogin(ctx);
      if (!creds) return; // 取消或失败，原因已提示
      saveCredentials(creds, { userOpenid: creds.userOpenid });
      startWithCredentials(ctx, creds, { ...config, allowedOpenid: creds.userOpenid ?? config.allowedOpenid }, "扫码登录");
    },
  });

  pi.registerCommand("qq-status", {
    description: "pi-qq：查看登录态、连接状态与绑定用户",
    handler: async (_args, ctx) => {
      const { config, error } = readConfig();
      const creds = error ? null : getCredentials(config);
      const source = creds ? (config.AppID ? "配置文件（AppID）" : "扫码写入") : "未配置";
      const lines = [
        "pi-qq 状态",
        `连接：${lastState}${stateDetail ? `（${stateDetail}）` : ""}`,
        creds ? `凭据：${maskAppId(creds.appId)}（来源：${source}）` : "凭据：未配置",
        `绑定用户：${config.allowedOpenid ?? "未绑定"}`,
        "配置文件：~/.pi/agent/pi-qq.json",
      ];
      ctx.ui.notify(lines.join("\n"), error ? "warning" : "info");
    },
  });

  pi.registerCommand("qq-logout", {
    description: "pi-qq：清除凭据并断开连接（保留绑定与设置）",
    handler: async (_args, ctx) => {
      stopIfRunning();
      clearCredentials();
      ctx.ui.notify("pi-qq 已断开并清除凭据（绑定与设置保留）", "info");
    },
  });

  // —— 诊断命令（markdown / 流式能力实证）——

  const diagTarget = () => {
    const last = budget.lastTarget;
    if (last) return { scope: "c2c" as const, targetId: last.openid, msgId: last.msgId };
    const bound = readConfig().config.allowedOpenid;
    return bound ? { scope: "c2c" as const, targetId: bound } : undefined;
  };

  pi.registerCommand("qq-md", {
    description: "pi-qq 诊断：发送一条 Markdown 消息（验证 C2C markdown 渲染能力）",
    handler: async (args, ctx) => {
      if (!running) {
        ctx.ui.notify("pi-qq 未连接", "warning");
        return;
      }
      const target = diagTarget();
      if (!target) {
        ctx.ui.notify("pi-qq：无可用发送目标（请先在 QQ 发一条消息，或配置 allowedOpenid）", "warning");
        return;
      }
      const content =
        args?.trim() ||
        "**Markdown 测试**\n# 一级标题\n- 列表项一\n- 列表项二\n[链接](https://qq.com)";
      try {
        await running.bot.sendMarkdown(target, content);
        ctx.ui.notify(
          "已发送 Markdown 测试消息：若 QQ 中渲染为富文本 → C2C markdown 可用；若显示原文/报错 → 记录现象",
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Markdown 发送失败：${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("qq-stream-test", {
    description: "pi-qq 诊断：追加模式（append）流式测试——两帧增量 + DONE",
    handler: async (_args, ctx) => {
      if (!running) {
        ctx.ui.notify("pi-qq 未连接", "warning");
        return;
      }
      const last = budget.lastTarget;
      if (!last) {
        ctx.ui.notify("pi-qq：请先在 QQ 给机器人发一条消息（流式需要锚定 msgId）", "warning");
        return;
      }
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        const stream = new AppendStream(
          running.bot.messageApi,
          running.bot.getCredentials(),
          last.openid,
          last.msgId,
        );
        await stream.append("💭 思考中…\n");
        await sleep(800);
        await stream.append("🔧 bash\n🔧 read\n");
        await sleep(800);
        await stream.append("**智能体消息**：第一回合回复内容。\n");
        await sleep(800);
        await stream.append("\n这是最终回复的流式追加内容。");
        let doneNote = "DONE 成功";
        try {
          await stream.done();
        } catch (doneErr) {
          doneNote = `DONE 帧被拒：${(doneErr as Error).message}`;
        }
        ctx.ui.notify(
          `时间线流式测试：各帧成功、${doneNote}。请看 QQ：气泡应为 💭/🔧/消息文本 的时间线形态`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`append 流式测试失败：${(err as Error).message}`, "error");
      }
    },
  });
}
