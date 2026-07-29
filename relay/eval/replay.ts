// Replay harness (P0 task 4) — ZERO TOKEN. Reads a frozen shadow-log corpus and
// re-derives the deterministic facts from it. Gate A in embryo.
//
// WHAT THIS IS NOT: it does not call an LLM. Running the real pipeline over the
// corpus would emit BRAND NEW cards that have no labels, so it could neither
// reproduce a precision number nor be compared against history — and the
// "identical across two runs" property we want would be impossible. Live
// inference over ~30 gold threads is Gate B (P2).
//
// WHAT IT IS FOR: asserting invariants over what the system ACTUALLY produced,
// cheaply enough to run on every commit. Every number below is computed from
// recorded bytes, so two runs over the same corpus are byte-identical.

import type { ShadowRecord } from "../core/shadow.js";

export interface ReplayCorpus {
  rounds: ShadowRecord[];
  frozen_at: string;
  round_count: number;
}

export function parseCorpus(text: string, frozenAt: string): ReplayCorpus {
  const rounds: ShadowRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      rounds.push(JSON.parse(t) as ShadowRecord);
    } catch {
      // tolerate a truncated tail — an append-only log may be mid-write
    }
  }
  return { rounds, frozen_at: frozenAt, round_count: rounds.length };
}

export interface ReplayStats {
  rounds: number;
  source_messages: number;
  filtered: number;
  filtered_with_text: number; // the P0 gap: older rounds recorded no text
  actions_seen: number;
  distinct_action_ids: number;
  // Every id that ever appeared in a shadow round. The gap between this and what
  // survives in live state is the label leak P0 plugs.
  action_ids: string[];
  filter_reasons: Record<string, number>;
  by_action_type: Record<string, number>;
}

// Deterministic: iteration follows corpus order, and every derived collection is
// sorted before it leaves this function, so two runs serialize identically.
export function replayStats(corpus: ReplayCorpus): ReplayStats {
  let source_messages = 0;
  let filtered = 0;
  let filtered_with_text = 0;
  let actions_seen = 0;
  const ids = new Set<string>();
  const reasons = new Map<string, number>();
  const types = new Map<string, number>();

  for (const r of corpus.rounds) {
    source_messages += r.source_messages?.length ?? 0;
    for (const f of r.filtered ?? []) {
      filtered++;
      if (typeof f.text === "string" && f.text !== "") filtered_with_text++;
      reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + 1);
    }
    for (const a of r.actions ?? []) {
      actions_seen++;
      ids.add(a.id);
      types.set(a.action_type, (types.get(a.action_type) ?? 0) + 1);
    }
  }

  const sortRecord = (m: Map<string, number>): Record<string, number> =>
    Object.fromEntries([...m].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));

  return {
    rounds: corpus.round_count,
    source_messages,
    filtered,
    filtered_with_text,
    actions_seen,
    distinct_action_ids: ids.size,
    action_ids: [...ids].sort(),
    filter_reasons: sortRecord(reasons),
    by_action_type: sortRecord(types),
  };
}

// How much of what the system produced is still reachable in live state. A low
// survival rate is the label leak — and after P0 the leaked records live in the
// ledger instead of vanishing.
export interface SurvivalReport {
  seen: number;
  in_live_state: number;
  in_label_ledger: number;
  lost: number; // neither in state nor in the ledger — unrecoverable
  survival_rate: number;
}

export function survival(
  stats: ReplayStats,
  liveActionIds: Iterable<string>,
  ledgerActionIds: Iterable<string>,
): SurvivalReport {
  const live = new Set(liveActionIds);
  const ledger = new Set(ledgerActionIds);
  let inLive = 0;
  let inLedger = 0;
  let lost = 0;
  for (const id of stats.action_ids) {
    const l = live.has(id);
    const g = ledger.has(id);
    if (l) inLive++;
    if (g) inLedger++;
    if (!l && !g) lost++;
  }
  const seen = stats.action_ids.length;
  return {
    seen,
    in_live_state: inLive,
    in_label_ledger: inLedger,
    lost,
    survival_rate: seen > 0 ? (seen - lost) / seen : 1,
  };
}
