import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMsgSeqAllocator } from "../../src/relay/msg-seq";
import { sendWithMsgSeq } from "../../src/qq/msg-seq-send";

beforeEach(() => resetMsgSeqAllocator());

function makeBot() {
  const sends: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (options: Record<string, unknown>) => {
    sends.push(options);
    return { id: `message-${sends.length}` };
  });
  return { bot: { send } as never, sends };
}

describe("sendWithMsgSeq", () => {
  it("allocates increasing msg_seq per reply target", async () => {
    const { bot, sends } = makeBot();
    const target = { scope: "c2c", targetId: "openid-u", msgId: "msg-1" } as const;

    await sendWithMsgSeq(bot, { target, content: "one" });
    await sendWithMsgSeq(bot, { target, content: "two" });

    expect(sends[0]).toMatchObject({ target, content: "one", extra: { msg_seq: 0 } });
    expect(sends[1]).toMatchObject({ target, content: "two", extra: { msg_seq: 1 } });
  });

  it("does not add msg_seq for proactive sends", async () => {
    const { bot, sends } = makeBot();
    await sendWithMsgSeq(bot, { target: { scope: "c2c", targetId: "openid-u" }, content: "hello" });
    expect(sends[0]).toEqual({ target: { scope: "c2c", targetId: "openid-u" }, content: "hello" });
  });
});
