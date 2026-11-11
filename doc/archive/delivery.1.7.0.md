# pi-qq delivery 1.7.0

> **Delivery record.** 1.7.0 replaces the SDK's random `msg_seq` helper with a monotonic per-`msgId` allocator for every outbound message path. See [README](../../README.md) for current user-facing behavior.
> Version: 1.7.0
> Date: 2026-11-11
> Previous: [delivery.1.6.2.md](./delivery.1.6.2.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

1.6.2 added recovery for `40054005` after a duplicate `msgseq`, but kept the SDK's random `getNextMsgSeq()` helper. Random values in the range `0..65535` can collide within one inbound message, especially in long runs with hundreds of stream bubbles.

1.7.0 removes the randomness:

- allocate `msg_seq` monotonically per inbound `msgId`;
- use the allocator for custom stream messages;
- use the allocator for passive text, media, and diagnostic Markdown sends;
- keep proactive sends unchanged because they have no `msgId`;
- keep the existing fresh-stream recovery as a defensive fallback.

Out of scope:

- changing the QQ protocol range or `index` semantics;
- modifying the SDK package itself;
- changing proactive message sequencing;
- changing message formatting or relay behavior.

## 2. Final decisions

| #   | Question                                              | Decision                                                                                                  |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| D1  | Where does `msg_seq` come from?                       | A pi-qq-owned allocator keyed by `msgId`, not the SDK's random helper.                                    |
| D2  | What values are allocated?                            | `0, 1, 2, ...` independently for each `msgId`.                                                            |
| D3  | What happens after 65535 allocations for one message? | Throw `msg_seq exhausted for message` instead of wrapping and risking a duplicate.                        |
| D4  | Which sends use the allocator?                        | Custom `stream_messages`, passive text replies, media sends, and diagnostic Markdown.                     |
| D5  | Which sends do not?                                   | Proactive sends have no `msgId`; typing has no `msgId` and does not participate in message deduplication. |
| D6  | Is `40054005` recovery still needed?                  | Yes, as a fallback for any remaining or future collision source.                                          |

## 3. Implementation

New module:

| File                     | Responsibility                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `src/relay/msg-seq.ts`   | `allocateMsgSeq(msgId)` and test reset; per-`msgId` monotonic counter                     |
| `src/qq/msg-seq-send.ts` | `sendWithMsgSeq(bot, options)`; injects an allocated `msg_seq` for targets with a `msgId` |

Updated call sites:

| File                          | Change                                                   |
| ----------------------------- | -------------------------------------------------------- |
| `src/relay/stream-session.ts` | Uses `allocateMsgSeq()` instead of SDK `getNextMsgSeq()` |
| `src/qq/reply-sender.ts`      | Text chunks use `sendWithMsgSeq()`                       |
| `src/qq/media-tool.ts`        | Media sends use `sendWithMsgSeq()`                       |
| `src/qq/qq-diagnostics.ts`    | Diagnostic Markdown uses `sendWithMsgSeq()`              |

The helper calls the SDK's generic `send()` path with `extra.msg_seq`, so message type detection remains unchanged:

- `content` → text message;
- `markdown` → Markdown message;
- `media` → rich-media message.

## 4. Verification

Automated:

- **238 tests** across 24 files.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm pack --dry-run` pass.
- New tests cover:
  - independent counters for different `msgId` values;
  - reset behavior;
  - unique `msg_seq` for repeated text sends;
  - media sends through `sendWithMsgSeq()`;
  - no direct `sendText`, `sendMarkdown`, `sendMediaMessage`, or `getNextMsgSeq` use in pi-qq.

Not covered by a real QQ run in this release:

- exhaustion of all 65536 values for one message;
- a real collision after the allocator change (the automated allocator tests make this deterministic).

The 1.6.2 manual test remains the latest real QQ smoke test; it covered `/last`, `/status`, `/stop`, and normal text/stream output.

## 5. Risks and limitations

| Risk                                            | Impact                                                            | Handling                                               |
| ----------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `msgId -> next` map growth                      | One number per inbound message for the process lifetime           | Small per entry; can be pruned later if needed         |
| Sequence exhaustion                             | A single message cannot create more than 65536 outbound sends     | Explicit error instead of silent reuse                 |
| Proactive sends still use SDK sequencing        | They have no `msgId` and do not participate in per-message dedupe | Accepted                                               |
| SDK direct sends remain possible in future code | A new call could bypass the allocator                             | Code review and grep check for direct SDK send helpers |

## 6. References

- User-facing behavior: [README.md](../../README.md), [README-zh.md](../../README-zh.md).
- Previous delivery: [delivery.1.6.2.md](./delivery.1.6.2.md).
- Message sequence implementation: `src/relay/msg-seq.ts`, `src/qq/msg-seq-send.ts`.
