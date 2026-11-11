const REPLY_TYPES = ["full", "simple"] as const;

export type ReplyType = (typeof REPLY_TYPES)[number];

export const DEFAULT_REPLY_TYPE: ReplyType = "full";

export function isReplyType(value: unknown): value is ReplyType {
  return typeof value === "string" && (REPLY_TYPES as readonly string[]).includes(value);
}
