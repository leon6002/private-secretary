import { describe, it, expect } from "vitest";
import { parseCorpus, replayStats, survival } from "./replay.js";
import type { ShadowRecord } from "../core/shadow.js";
import type { ActionItem } from "../core/action-item.js";

function act(id: string, type: ActionItem["action_type"] = "task"): ActionItem {
  return {
    id,
    source_message_id: `wechat:${id}`,
    action_type: type,
    target: {},
    reason: "r",
    confidence: 0.7,
    params: {},
    status: "suggested",
    created_at: "2026-07-01T00:00:00Z",
  };
}

function round(over: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    schema_version: 1,
    round_at: "2026-07-01T00:00:00Z",
    runtime: "test",
    source_messages: [],
    filtered: [],
    actions: [],
    ...over,
  } as ShadowRecord;
}

const jsonl = (rs: ShadowRecord[]): string => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("replay harness (zero token)", () => {
  it("is deterministic: two runs over the same corpus serialize identically", () => {
    const text = jsonl([
      round({ actions: [act("b"), act("a")], filtered: [{ id: "f2", reason: "z" }, { id: "f1", reason: "a" }] }),
      round({ actions: [act("c", "calendar")], filtered: [{ id: "f3", reason: "a" }] }),
    ]);
    const one = JSON.stringify(replayStats(parseCorpus(text, "2026-07-28T00:00:00Z")));
    const two = JSON.stringify(replayStats(parseCorpus(text, "2026-07-28T00:00:00Z")));
    expect(one).toBe(two);
    // …and the ordering is normalized, not insertion-dependent.
    const s = replayStats(parseCorpus(text, "x"));
    expect(s.action_ids).toEqual(["a", "b", "c"]);
    expect(Object.keys(s.filter_reasons)).toEqual(["a", "z"]);
  });

  it("counts rounds / messages / filtered / actions from recorded bytes only", () => {
    const s = replayStats(
      parseCorpus(
        jsonl([
          round({ filtered: [{ id: "f1", reason: "already-answered" }] }),
          round({ actions: [act("a"), act("b", "reply")] }),
        ]),
        "x",
      ),
    );
    expect(s.rounds).toBe(2);
    expect(s.filtered).toBe(1);
    expect(s.actions_seen).toBe(2);
    expect(s.by_action_type).toEqual({ reply: 1, task: 1 });
  });

  it("tracks how many filtered rows carry text (the P0 recall gap)", () => {
    const s = replayStats(
      parseCorpus(
        jsonl([
          round({
            filtered: [
              { id: "old", reason: "promo" }, // pre-P0: no text
              { id: "new", reason: "promo", text: "buy now", sender: "x", platform: "gmail" },
              { id: "blank", reason: "promo", text: "" }, // empty doesn't count
            ],
          }),
        ]),
        "x",
      ),
    );
    expect(s.filtered).toBe(3);
    expect(s.filtered_with_text).toBe(1);
  });

  it("tolerates a truncated final line", () => {
    const s = replayStats(parseCorpus(jsonl([round({ actions: [act("a")] })]) + '{"schema_ver', "x"));
    expect(s.rounds).toBe(1);
    expect(s.actions_seen).toBe(1);
  });

  it("survival measures the label leak: in state, in ledger, or unrecoverable", () => {
    const stats = replayStats(parseCorpus(jsonl([round({ actions: [act("live"), act("rescued"), act("lost")] })]), "x"));
    const r = survival(stats, ["live"], ["rescued"]);
    expect(r.seen).toBe(3);
    expect(r.in_live_state).toBe(1);
    expect(r.in_label_ledger).toBe(1);
    expect(r.lost).toBe(1);
    expect(r.survival_rate).toBeCloseTo(2 / 3, 5);
  });

  it("a record in BOTH state and ledger is not double-counted as lost", () => {
    const stats = replayStats(parseCorpus(jsonl([round({ actions: [act("x")] })]), "x"));
    const r = survival(stats, ["x"], ["x"]);
    expect(r.lost).toBe(0);
    expect(r.survival_rate).toBe(1);
  });

  it("an empty corpus is survival 1, not NaN", () => {
    const r = survival(replayStats(parseCorpus("", "x")), [], []);
    expect(r.survival_rate).toBe(1);
  });
});
