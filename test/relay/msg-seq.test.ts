import { beforeEach, describe, expect, it } from "vitest";
import { allocateMsgSeq, resetMsgSeqAllocator } from "../../src/relay/msg-seq";

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
});
