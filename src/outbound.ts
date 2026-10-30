import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { ReplyBudget } from "./reply-budget";
import { log } from "./logger";

/**
 * pi → QQ text relay (F4 non-streaming path): lightweight Markdown-to-plain
 * conversion, long-text chunking, and passive-reply budget with fallback.
 */

/** Single-text limit; SDK splits around 5000 chars, leaving protocol headroom. */
export const TEXT_CHUNK_LIMIT = 4500;

/**
 * Markdown → plain text (features-v1.md F4: no Markdown permission by default).
 * Keep mobile readability; preserve fenced code content and drop only the fences.
 */
export function markdownToPlain(md: string): string {
  const out: string[] = [];
  let inFence = false;

  for (const raw of md.split("\n")) {
    // Code fences: toggle state; drop fence lines, keep content as-is.
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }

    let t = raw;

    // Tables: drop separator rows; strip edge pipes and trim data rows.
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(t) && t.includes("-") && t.includes("|")) {
      continue;
    }
    if (t.trimStart().startsWith("|") || t.trimEnd().endsWith("|")) {
      t = t
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .trim();
    }

    // Headings / quotes / horizontal rules
    t = t.replace(/^\s{0,3}#{1,6}\s+/, "");
    t = t.replace(/^\s{0,3}>\s?/, "");
    if (/^\s{0,3}([-*_]\s*){3,}$/.test(t)) {
      out.push("");
      continue;
    }

    // Images: keep alt text
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    // Links: text (url); keep only url when text equals url
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) =>
      text === url ? url : `${text}（${url}）`,
    );
    // Emphasis / inline code / strikethrough
    t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
    t = t.replace(/__([^_]+)__/g, "$1");
    t = t.replace(/`([^`]+)`/g, "$1");
    t = t.replace(/~~([^~]+)~~/g, "$1");
    t = t.replace(/\*([^*\n]+)\*/g, "$1");
    t = t.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1");

    // Unordered lists → •; ordered lists unchanged
    t = t.replace(/^(\s*)[-*+]\s+/, "$1• ");

    out.push(t);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Chunk long text at newlines when possible; hard-cut when there is no newline.
 */
export function chunkText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    cut = cut <= 0 ? limit : cut + 1; // +1 keeps the newline at the end of the chunk
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Send-channel dependencies: budget, fallback recipient, warning sink. */
export interface ReplyChannel {
  budget: ReplyBudget;
  /** Bound user openid: fallback recipient for proactive sends. */
  boundOpenid: string;
  onWarn?: (msg: string) => void;
}

/**
 * Send one reply (auto-chunked, one budget ticket per chunk).
 * A failed passive send retries once as proactive.
 *
 * When QQBot is constructed with markdownSupport=true, the SDK's sendText
 * automatically uses msg_type=2 (markdown); callers only decide whether the
 * payload keeps Markdown, with no separate sendMarkdown path needed here.
 */
export async function sendReply(bot: QQBot, text: string, ch: ReplyChannel): Promise<void> {
  for (const chunk of chunkText(text)) {
    const { mode, openid, msgId } = ch.budget.acquire();
    const targetId = mode === "proactive" ? ch.boundOpenid : (openid ?? ch.boundOpenid);
    const replyTarget =
      mode === "passive" && msgId ? { scope: "c2c" as const, targetId, msgId } : { scope: "c2c" as const, targetId };
    try {
      log.debug("outbound", "sending text chunk", {
        mode,
        targetId,
        msgId: msgId ?? null,
        length: chunk.length,
        text: chunk,
      });
      await bot.sendText(replyTarget, chunk);
      if (mode === "passive" && msgId) ch.budget.commitPassive(msgId);
      log.info("outbound", "text chunk sent", { mode, targetId, length: chunk.length });
    } catch (err) {
      log.warn("outbound", "text chunk failed", {
        mode,
        targetId,
        length: chunk.length,
        err,
      });
      if (mode === "passive") {
        // Passive failure (e.g. stale msgId) → retry once proactively.
        try {
          log.warn("outbound", "passive send failed; retrying proactively", { targetId: ch.boundOpenid });
          await bot.sendText({ scope: "c2c", targetId: ch.boundOpenid }, chunk);
          ch.onWarn?.("Passive reply failed; falling back to proactive.");
          continue;
        } catch (retryErr) {
          log.error("outbound", "proactive retry failed", { targetId: ch.boundOpenid, err: retryErr });
          ch.onWarn?.(`Proactive send failed: ${(retryErr as Error).message}`);
          continue;
        }
      }
      ch.onWarn?.(`Send failed: ${(err as Error).message}`);
    }
  }
}
