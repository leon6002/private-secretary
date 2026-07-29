import { describe, it, expect } from "vitest";
import {
  computeGate,
  REQUIRE_CROSS_LANG,
  type DraftOutcome,
  type Decision,
  type Direction,
} from "./metrics.js";

function outcome(
  i: number,
  decision: Decision,
  contactKey: string,
  direction: Direction,
  wrongRecipient = false,
): DraftOutcome {
  return { relayId: `r${i}`, contactKey, direction, decision, wrongRecipient };
}

// Build a passing window: 20 drafts, 16 clean, 3 contacts, both directions, no wrong-recipient.
function passingWindow(): DraftOutcome[] {
  const out: DraftOutcome[] = [];
  for (let i = 0; i < 16; i++) {
    out.push(outcome(i, "approve-clean", `c${i % 3}`, i % 2 === 0 ? "en->zh" : "zh->en"));
  }
  for (let i = 16; i < 20; i++) {
    out.push(outcome(i, "edit", `c${i % 3}`, "en->zh"));
  }
  return out;
}

describe("computeGate", () => {
  it("passes a clean 16/20 window across 3 contacts and both directions", () => {
    const r = computeGate(passingWindow());
    expect(r.pass).toBe(true);
    expect(r.cleanApprovals).toBe(16);
    expect(r.distinctContacts).toBe(3);
    expect(r.directionsCovered).toBe(2);
  });

  it("counts trivial edits as clean approvals", () => {
    const w = passingWindow();
    w[0] = outcome(0, "approve-trivial", "c0", "en->zh");
    expect(computeGate(w).pass).toBe(true);
  });

  it("fails when fewer than 16 clean approvals", () => {
    const w = passingWindow();
    w[0] = outcome(0, "edit", "c0", "en->zh");
    const r = computeGate(w);
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes("clean approvals"))).toBe(true);
  });

  // 2026-06-11 user decision: cross-language coverage SUSPENDED until WeChat lands
  // (REQUIRE_CROSS_LANG = false). Coverage is still computed/reported; these tests
  // pin both the suspended behavior and the reporting.
  it("single-direction window passes while REQUIRE_CROSS_LANG is false (still reported)", () => {
    const w = passingWindow().map((o) => ({ ...o, direction: "en->zh" as Direction }));
    const r = computeGate(w);
    expect(REQUIRE_CROSS_LANG).toBe(false);
    expect(r.pass).toBe(true);
    expect(r.directionsCovered).toBe(1);
  });

  it("an all same-language clean window passes the suspended gate, coverage reported as 0", () => {
    // 20 clean, 3 contacts, every direction same-language → passes for now (en->en
    // secretary value gates Phase 2; cross-language re-arms with WeChat).
    const w: DraftOutcome[] = Array.from({ length: 20 }, (_, i) =>
      outcome(i, "approve-clean", `c${i % 3}`, i % 2 === 0 ? "en->en" : "zh->zh"),
    );
    const r = computeGate(w);
    expect(r.cleanApprovals).toBe(20);
    expect(r.pass).toBe(true);
    expect(r.directionsCovered).toBe(0);
    expect(r.reasons).toEqual([]);
  });

  it("a mix where both cross-language directions appear passes and reports 2", () => {
    const w = passingWindow();
    w[0] = outcome(0, "approve-clean", "c0", "en->en"); // same-lang is fine alongside
    w[1] = outcome(1, "approve-clean", "c1", "en->zh");
    w[2] = outcome(2, "approve-clean", "c2", "zh->en");
    const r = computeGate(w);
    expect(r.pass).toBe(true);
    expect(r.directionsCovered).toBe(2);
  });

  it("fails on any wrong-recipient incident, even with enough clean approvals", () => {
    const w = passingWindow();
    w[5] = { ...w[5]!, wrongRecipient: true };
    const r = computeGate(w);
    expect(r.pass).toBe(false);
    expect(r.wrongRecipientCount).toBe(1);
  });

  it("fails when fewer than 20 drafts surfaced", () => {
    const r = computeGate(passingWindow().slice(0, 10));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.includes("surfaced"))).toBe(true);
  });

  it("uses only the most recent 20 (window slides)", () => {
    const old = Array.from({ length: 10 }, (_, i) => outcome(i, "skip", "old", "en->zh"));
    const r = computeGate([...old, ...passingWindow()]);
    expect(r.pass).toBe(true);
    expect(r.surfaced).toBe(20);
  });
});
