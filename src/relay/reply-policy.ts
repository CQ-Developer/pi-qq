import type { ReplyType } from "../infra/reply-type";

export interface ReplyPolicy {
  relayThinking: boolean;
  relayTools: boolean;
  deferTextWhileToolsPending: boolean;
}

const POLICIES: Record<ReplyType, ReplyPolicy> = {
  full: {
    relayThinking: true,
    relayTools: true,
    deferTextWhileToolsPending: true,
  },
  simple: {
    relayThinking: false,
    relayTools: false,
    deferTextWhileToolsPending: false,
  },
};

export function policyFor(type: ReplyType): ReplyPolicy {
  return POLICIES[type];
}
