const MAX_MSG_SEQ = 0xffff;
const nextByMsgId = new Map<string, number>();

export function allocateMsgSeq(msgId: string): number {
  const next = nextByMsgId.get(msgId) ?? 0;
  if (next > MAX_MSG_SEQ) {
    throw new Error("msg_seq exhausted for message");
  }
  nextByMsgId.set(msgId, next + 1);
  return next;
}

export function resetMsgSeqAllocator(): void {
  nextByMsgId.clear();
}
