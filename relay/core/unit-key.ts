// P1 — durable task identity. The plan layer (loop-state.plans / planOverrides)
// and the cockpit clusters key a task unit by `task_id ?? fallback`. Two leaks
// made that identity non-durable:
//
//   1. Supersede dropped task_id. When a fresh draft replaced a still-suggested
//      same-sender card (scan-loop phase 3, or the refresh pass), the new card
//      carried NO task_id — consolidation assigns it later — so the plan +
//      cockpit cluster detached from the task on every supersede.
//      inheritSupersededTaskIds closes this by COPYING the doomed card's
//      task_id onto its replacement (never minting a new one — round-commit
//      must not invent task_ids).
//
//   2. The standalone fallback `__ungrouped_<actionId>` changed on every
//      supersede (fresh card, fresh id), orphaning plans/overrides keyed to
//      it. unitKey now derives the fallback from the conversation key
//      (platform + sender) via stableHash, so it survives a supersede; the
//      action id is only the last resort for a sender-less card (which never
//      supersedes anyway).
//
// Pure core: no I/O, no imports beyond types.

import type { ActionItem } from "./action-item.js";

// Conversation-cluster key: platform (from the source_message_id prefix) +
// sender handle. Null when there's no sender to cluster on — a sender-less
// card never supersedes and falls back to its own id. Two cards with the same
// key are the same conversation.
export function clusterKey(a: ActionItem): string | null {
  const sender = a.context?.sender_handle;
  if (!sender) return null;
  const platform = a.source_message_id.split(":")[0] ?? "";
  return `${platform}::${sender}`;
}

// Tiny deterministic FNV-1a (32-bit, hex). MUST STAY STABLE FOREVER —
// persisted unit keys (plans, planOverrides) derive from it; changing the
// algorithm orphans every stored standalone-unit key.
export function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// The unit key a plan / cockpit cluster attaches to. task_id wins; a
// standalone card keys by its CONVERSATION (stable across supersede), not its
// action id (which changes on every supersede). The `__ungrouped_` prefix is
// kept so existing string handling stays valid.
export function unitKey(a: ActionItem): string {
  if (a.task_id) return a.task_id;
  const k = clusterKey(a);
  return k ? `__ungrouped_${stableHash(k)}` : `__ungrouped_${a.id}`;
}

// Supersede task_id inheritance (leak 1): a fresh card replacing a still-
// suggested same-conversation card inherits that card's task_id, so the plan
// and cockpit cluster stay attached to the task. Only COPIES — a card with
// its own task_id is left alone, and no new ids are minted. Inputs are not
// mutated.
export function inheritSupersededTaskIds(
  incoming: ActionItem[],
  superseded: ActionItem[],
): ActionItem[] {
  const byKey = new Map<string, string>();
  for (const s of superseded) {
    if (!s.task_id) continue;
    const k = clusterKey(s);
    if (k && !byKey.has(k)) byKey.set(k, s.task_id);
  }
  if (byKey.size === 0) return incoming;
  return incoming.map((a) => {
    if (a.task_id) return a;
    const k = clusterKey(a);
    const inherited = k ? byKey.get(k) : undefined;
    return inherited ? { ...a, task_id: inherited } : a;
  });
}
