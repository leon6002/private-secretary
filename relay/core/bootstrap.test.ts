import { describe, it, expect } from "vitest";
import {
  initProgress,
  markContact,
  monthIndex,
  nextPending,
  progressSummary,
  rankContacts,
  recencyWeight,
  type BootstrapProgress,
} from "./bootstrap.js";

const NOW = "2026-06-11T00:00:00Z";

describe("recency weighting", () => {
  it("full weight within 12 months, 0.2 floor at 60+, linear between", () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(12)).toBe(1);
    expect(recencyWeight(36)).toBeCloseTo(0.6);
    expect(recencyWeight(60)).toBe(0.2);
    expect(recencyWeight(120)).toBe(0.2);
  });
  it("monthIndex parses YYYY-MM and rejects garbage", () => {
    expect(monthIndex("2026-06") - monthIndex("2025-06")).toBe(12);
    expect(() => monthIndex("junk")).toThrow(/bad month/);
  });
});

describe("rankContacts (volume x recency)", () => {
  it("recent traffic outranks larger but stale traffic", () => {
    const ranked = rankContacts(
      [
        { handle: "old-flood", monthly_counts: { "2021-06": 1000 } }, // 60mo -> 200
        { handle: "recent", monthly_counts: { "2026-05": 300 } }, // -> 300
      ],
      "2026-06",
    );
    expect(ranked[0]!.handle).toBe("recent");
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[1]!.score).toBe(200);
  });
  it("ties break by total then handle for stable output", () => {
    const ranked = rankContacts(
      [
        { handle: "b", monthly_counts: { "2026-05": 10 } },
        { handle: "a", monthly_counts: { "2026-05": 10 } },
      ],
      "2026-06",
    );
    expect(ranked.map((r) => r.handle)).toEqual(["a", "b"]);
  });
});

describe("bootstrap progress (resume semantics — done means PROMOTED)", () => {
  const entries = [
    { key: "michael-dobosz", display_name: "Michael" },
    { key: "brendan-odoherty", display_name: "Brendan" },
  ];
  const params = { contacts: "top:20", history_years: 5 };

  it("init marks everyone pending; next walks in order; mark advances", () => {
    let p = initProgress(null, params, entries, NOW);
    expect(nextPending(p)).toBe("michael-dobosz");
    p = markContact(p, "michael-dobosz", "staged", NOW);
    expect(nextPending(p)).toBe("brendan-odoherty");
    expect(progressSummary(p)).toEqual({ pending: 1, staged: 1, promoted: 0, failed: 0 });
  });

  it("re-init redoes staged-but-not-promoted (incomplete) and failed", () => {
    let p = initProgress(null, params, entries, NOW);
    p = markContact(p, "michael-dobosz", "staged", NOW);
    p = markContact(p, "brendan-odoherty", "failed", NOW, "mcp timeout");
    const resumed = initProgress(p, params, entries, NOW);
    expect(resumed.contacts["michael-dobosz"]!.status).toBe("pending");
    expect(resumed.contacts["brendan-odoherty"]!.status).toBe("pending");
    expect(resumed.contacts["brendan-odoherty"]!.error).toBeUndefined();
  });

  it("top:20 then all = zero duplicate processing (promoted stays done)", () => {
    let p = initProgress(null, params, [entries[0]!], NOW);
    p = markContact(p, "michael-dobosz", "staged", NOW);
    p = markContact(p, "michael-dobosz", "promoted", NOW);
    const allRun = initProgress(p, { contacts: "all", history_years: 5 }, entries, NOW);
    expect(allRun.contacts["michael-dobosz"]!.status).toBe("promoted");
    expect(nextPending(allRun)).toBe("brendan-odoherty");
  });

  it("explicit list (force) re-processes even promoted contacts", () => {
    let p = initProgress(null, params, [entries[0]!], NOW);
    p = markContact(p, "michael-dobosz", "promoted", NOW);
    const forced = initProgress(
      p,
      { contacts: "michael-dobosz", history_years: 5 },
      [entries[0]!],
      NOW,
      ["michael-dobosz"],
    );
    expect(forced.contacts["michael-dobosz"]!.status).toBe("pending");
  });

  it("interrupted run resumes without touching finished work", () => {
    let p: BootstrapProgress = initProgress(null, params, entries, NOW);
    p = markContact(p, "michael-dobosz", "staged", NOW);
    p = markContact(p, "michael-dobosz", "promoted", NOW);
    // crash here; re-run with same list
    const resumed = initProgress(p, params, entries, NOW);
    expect(resumed.contacts["michael-dobosz"]!.status).toBe("promoted");
    expect(nextPending(resumed)).toBe("brendan-odoherty");
  });
});
