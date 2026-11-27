const MAX_MSG_SEQ = 0xffff;
export const MSG_SEQ_TTL_MS = 24 * 60 * 60_000;
export const MAX_TRACKED_MSG_IDS = 1_000;

interface MsgSeqEntry {
  next: number;
  touchedAt: number;
}

const nextByMsgId = new Map<string, MsgSeqEntry>();

function pruneExpired(now: number): void {
  for (const [msgId, entry] of nextByMsgId) {
    if (now - entry.touchedAt > MSG_SEQ_TTL_MS) nextByMsgId.delete(msgId);
  }
}

export function allocateMsgSeq(msgId: string, now = Date.now()): number {
  pruneExpired(now);
  let entry = nextByMsgId.get(msgId);
  if (entry) {
    // Keep recently used messages at the tail so the cap evicts stale entries.
    nextByMsgId.delete(msgId);
  } else {
    if (nextByMsgId.size >= MAX_TRACKED_MSG_IDS) {
      const oldest = nextByMsgId.keys().next().value;
      if (oldest !== undefined) nextByMsgId.delete(oldest);
    }
    entry = { next: 0, touchedAt: now };
  }

  if (entry.next > MAX_MSG_SEQ) {
    throw new Error("msg_seq exhausted for message");
  }
  const seq = entry.next;
  entry.next += 1;
  entry.touchedAt = now;
  nextByMsgId.set(msgId, entry);
  return seq;
}

export function resetMsgSeqAllocator(): void {
  nextByMsgId.clear();
}
