import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { ReplyBudget } from "./reply-budget";

/**
 * pi → QQ 的文本回传（F4 非流式路径）：
 * markdown → 纯文本轻量转换、超长分块、按被动回复预算发牌与降级。
 */

/** 单条文本上限。SDK 内部按 ~5000 字符切分，这里留出协议余量。 */
export const TEXT_CHUNK_LIMIT = 4500;

/**
 * Markdown → 纯文本（features.md F4：默认机器人无 markdown 权限，
 * 轻量转换保持手机端可读性；代码围栏内容原样保留，仅去掉围栏标记）。
 */
export function markdownToPlain(md: string): string {
  const out: string[] = [];
  let inFence = false;

  for (const raw of md.split("\n")) {
    // 代码围栏：翻转状态，标记行不输出，内容行原样保留
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }

    let t = raw;

    // 表格：分隔行丢弃，数据行去掉首尾竖线并收紧边缘空格（逐行退化）
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(t) && t.includes("-") && t.includes("|")) {
      continue;
    }
    if (t.trimStart().startsWith("|") || t.trimEnd().endsWith("|")) {
      t = t.replace(/^\s*\|/, "").replace(/\|\s*$/, "").trim();
    }

    // 标题 / 引用 / 水平线
    t = t.replace(/^\s{0,3}#{1,6}\s+/, "");
    t = t.replace(/^\s{0,3}>\s?/, "");
    if (/^\s{0,3}([-*_]\s*){3,}$/.test(t)) {
      out.push("");
      continue;
    }

    // 图片：保留 alt 文本
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    // 链接：文字（url）；文字与 url 相同则只留 url
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) =>
      text === url ? url : `${text}（${url}）`,
    );
    // 强调 / 行内代码 / 删除线
    t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
    t = t.replace(/__([^_]+)__/g, "$1");
    t = t.replace(/`([^`]+)`/g, "$1");
    t = t.replace(/~~([^~]+)~~/g, "$1");
    t = t.replace(/\*([^*\n]+)\*/g, "$1");
    t = t.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1");

    // 无序列表 → •；有序列表保持原样
    t = t.replace(/^(\s*)[-*+]\s+/, "$1• ");

    out.push(t);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 超长文本分块：优先在换行处断开，避免切断整行；无换行时硬切。
 */
export function chunkText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    cut = cut <= 0 ? limit : cut + 1; // +1 把换行符留在当前块末尾
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** 发送通道依赖：预算 + 兜底收件人 + 告警出口。 */
export interface ReplyChannel {
  budget: ReplyBudget;
  /** 绑定用户 openid：proactive 模式与无入站记录时的兜底收件人 */
  boundOpenid: string;
  onWarn?: (msg: string) => void;
}

/**
 * 发送一条回传（自动分块、逐块发牌）。
 * passive 发送失败时自动降级为 proactive 重试一次。
 *
 * QQBot 构造时 markdownSupport=true 的情况下，SDK 的 sendText 会自动使用
 * msg_type=2（markdown），因此调用方只需决定 payload 是否保留 Markdown，
 * 无需在这里区分 sendMarkdown。
 */
export async function sendReply(bot: QQBot, text: string, ch: ReplyChannel): Promise<void> {
  for (const chunk of chunkText(text)) {
    const { mode, openid, msgId } = ch.budget.acquire();
    const targetId = mode === "proactive" ? ch.boundOpenid : (openid ?? ch.boundOpenid);
    const replyTarget =
      mode === "passive" && msgId
        ? { scope: "c2c" as const, targetId, msgId }
        : { scope: "c2c" as const, targetId };
    try {
      await bot.sendText(replyTarget, chunk);
      if (mode === "passive" && msgId) ch.budget.commitPassive(msgId);
    } catch (err) {
      if (mode === "passive") {
        // msgId 失效等被动失败 → 主动重试一次
        try {
          await bot.sendText({ scope: "c2c", targetId: ch.boundOpenid }, chunk);
          ch.onWarn?.("被动回复失败，已降级主动发送");
          continue;
        } catch (retryErr) {
          ch.onWarn?.(`主动发送也失败：${(retryErr as Error).message}`);
          continue;
        }
      }
      ch.onWarn?.(`发送失败：${(err as Error).message}`);
    }
  }
}
