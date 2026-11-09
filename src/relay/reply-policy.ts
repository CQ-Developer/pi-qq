import type { ReplyType } from "../infra/reply-type";

export interface ReplyPolicy {
  relayThinking: boolean;
  relayTools: boolean;
  relayTextLive: boolean;
  deferTextWhileToolsPending: boolean;
  deliverLastAtEnd: boolean;
}

const POLICIES: Record<ReplyType, ReplyPolicy> = {
  full: {
    relayThinking: true,
    relayTools: true,
    relayTextLive: true,
    deferTextWhileToolsPending: true,
    deliverLastAtEnd: false,
  },
  simple: {
    relayThinking: false,
    relayTools: false,
    relayTextLive: true,
    deferTextWhileToolsPending: false,
    deliverLastAtEnd: false,
  },
  last: {
    relayThinking: false,
    relayTools: false,
    relayTextLive: false,
    deferTextWhileToolsPending: false,
    deliverLastAtEnd: true,
  },
};

export function policyFor(type: ReplyType): ReplyPolicy {
  return POLICIES[type];
}
