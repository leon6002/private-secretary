// Cross-message merge: messages from the same sender within one scan round are
// analyzed together (one coherent intent analysis per sender, not 3 contradictory
// replies for 3 emails of the same thread).

import type { InboundMessage } from "./types.js";

export function senderKey(m: InboundMessage): string {
  return `${m.platform}:${m.senderHandle}`;
}

// Groups by platform+sender, each group sorted oldest-first so the analysis reads
// the conversation in order.
export function groupBySender(
  messages: InboundMessage[],
): Map<string, InboundMessage[]> {
  const groups = new Map<string, InboundMessage[]>();
  const sorted = [...messages].sort((a, b) => a.timestampMs - b.timestampMs);
  for (const m of sorted) {
    const key = senderKey(m);
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }
  return groups;
}
