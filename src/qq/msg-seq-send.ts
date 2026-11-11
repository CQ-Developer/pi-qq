import type { QQBot, SendMessageOptions } from "@tencent-connect/qqbot-nodejs";
import { allocateMsgSeq } from "../relay/msg-seq";

export function sendWithMsgSeq(bot: QQBot, options: SendMessageOptions) {
  const msgId = options.target.msgId;
  if (!msgId) return bot.send(options);
  return bot.send({
    ...options,
    extra: { ...options.extra, msg_seq: allocateMsgSeq(msgId) },
  });
}
