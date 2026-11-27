import { beforeEach, describe, expect, it } from "vitest";
import { allocateMsgSeq, MAX_TRACKED_MSG_IDS, MSG_SEQ_TTL_MS, resetMsgSeqAllocator } from "../../src/relay/msg-seq";

beforeEach(() => resetMsgSeqAllocator());

describe("allocateMsgSeq", () => {
  it("increments independently per msgId", () => {
    expect(allocateMsgSeq("msg-a")).toBe(0);
    expect(allocateMsgSeq("msg-a")).toBe(1);
    expect(allocateMsgSeq("msg-a")).toBe(2);
    expect(allocateMsgSeq("msg-b")).toBe(0);
    expect(allocateMsgSeq("msg-b")).toBe(1);
  });

  it("starts over after a reset", () => {
    expect(allocateMsgSeq("msg-a")).toBe(0);
    resetMsgSeqAllocator();
    expect(allocateMsgSeq("msg-a")).toBe(0);
  });

  it("evicts entries after the TTL", () => {
    const start = 1_000_000;
    expect(allocateMsgSeq("msg-a", start)).toBe(0);
    expect(allocateMsgSeq("msg-a", start + MSG_SEQ_TTL_MS)).toBe(1);
    expect(allocateMsgSeq("msg-a", start + MSG_SEQ_TTL_MS * 2 + 1)).toBe(0);
  });

  it("caps tracked message IDs and evicts the oldest entry", () => {
    const start = 2_000_000;
    for (let i = 0; i < MAX_TRACKED_MSG_IDS; i += 1) allocateMsgSeq(`msg-${i}`, start);
    expect(allocateMsgSeq("msg-0", start + 1)).toBe(1);
    expect(allocateMsgSeq("new-msg", start + 1)).toBe(0);
    expect(allocateMsgSeq("msg-1", start + 1)).toBe(0);
    expect(allocateMsgSeq("msg-0", start + 1)).toBe(2);
  });
});
