import { describe, it, expect } from "vitest";
import { buildBaseline, renderBaselineMarkdown, SMALL_N } from "./baseline.js";
import type { LabelRecord } from "../io/labels.js";
import { buildLabel } from "../io/labels.js";
import type { ActionItem, ActionType } from "../core/action-item.js";

function label(
  over: {
    type?: ActionType;
    decision?: LabelRecord["decision"];
    existence?: LabelRecord["existence"];
    confidence?: number;
  } = {},
): LabelRecord {
  const action: ActionItem = {
    id: Math.random().toString(36).slice(2),
    source_message_id: "wechat:x",
    action_type: over.type ?? "task",
    target: {},
    reason: "r",
    confidence: over.confidence ?? 0.7,
    params: {},
    status: over.decision === "executed" ? "executed" : "rejected",
    created_at: "2026-07-01T00:00:00Z",
  };
  const rec = buildLabel({ action, decision: over.decision ?? "rejected" });
  rec.existence = over.existence ?? null;
  return rec;
}

describe("baseline report", () => {
  it("never blends types: each action_type gets its own precision", () => {
    const rep = buildBaseline(
      [
        ...Array.from({ length: 16 }, () => label({ type: "reply", decision: "executed" })),
        ...Array.from({ length: 79 }, () => label({ type: "reply", decision: "rejected" })),
        ...Array.from({ length: 92 }, () => label({ type: "ignore", decision: "executed" })),
        ...Array.from({ length: 17 }, () => label({ type: "ignore", decision: "rejected" })),
      ],
      "2026-07-28T00:00:00Z",
    );
    const reply = rep.by_type.find((s) => s.action_type === "reply")!;
    const ignore = rep.by_type.find((s) => s.action_type === "ignore")!;
    // The two real numbers from Leo's history — and they must stay separate.
    expect(reply.precision).toBeCloseTo(0.168, 3);
    expect(ignore.precision).toBeCloseTo(0.844, 3);
    // There is deliberately NO overall precision field to misread.
    expect((rep as unknown as Record<string, unknown>).precision).toBeUndefined();
  });

  it("deferred is excluded from the precision denominator", () => {
    // 1 executed, 1 real rejection, 8 deferrals → precision must be 0.5, not 0.1.
    const rep = buildBaseline(
      [
        label({ decision: "executed" }),
        label({ decision: "rejected", existence: "not_a_thing" }),
        ...Array.from({ length: 8 }, () => label({ decision: "rejected", existence: "deferred" })),
      ],
      "2026-07-28T00:00:00Z",
    );
    const t = rep.by_type[0]!;
    expect(t.executed).toBe(1);
    expect(t.rejected).toBe(1);
    expect(t.deferred).toBe(8);
    expect(t.decided).toBe(2);
    expect(t.precision).toBeCloseTo(0.5, 5);
  });

  it("superseded / pruned are lifecycle events, never counted as judgements", () => {
    const rep = buildBaseline(
      [
        label({ decision: "executed" }),
        label({ decision: "superseded" }),
        label({ decision: "pruned" }),
      ],
      "2026-07-28T00:00:00Z",
    );
    expect(rep.human_decided).toBe(1);
    expect(rep.lifecycle_only).toBe(2);
    expect(rep.by_type[0]!.decided).toBe(1);
  });

  it("flags small-n cells instead of quietly reporting them", () => {
    const rep = buildBaseline(
      Array.from({ length: SMALL_N - 1 }, () => label({ decision: "executed" })),
      "2026-07-28T00:00:00Z",
    );
    expect(rep.by_type[0]!.small_n).toBe(true);
    expect(renderBaselineMarkdown(rep)).toContain("n 过小");
  });

  it("keeps EXACT confidence values distinct — rounding hides a real effect", () => {
    // The finding this guards: task conf=0.9 approves at ~0.96, conf=0.85 at
    // ~0.33. Rounded into one "0.9 bucket" they average to ~0.85 and would
    // justify a ≥0.85 gate that the data rejects.
    const rep = buildBaseline(
      [
        ...Array.from({ length: 26 }, () => label({ confidence: 0.9, decision: "executed" })),
        label({ confidence: 0.9, decision: "rejected" }),
        ...Array.from({ length: 2 }, () => label({ confidence: 0.85, decision: "executed" })),
        ...Array.from({ length: 4 }, () => label({ confidence: 0.85, decision: "rejected" })),
      ],
      "2026-07-28T00:00:00Z",
    );
    const exact = rep.exact_confidence_by_type.task!;
    const at90 = exact.find((c) => c.bucket === 0.9)!;
    const at85 = exact.find((c) => c.bucket === 0.85)!;
    expect(at90.approveRate!).toBeGreaterThan(0.9);
    expect(at85.approveRate!).toBeLessThan(0.4);

    // …while the rounded view collapses both into one misleading cell.
    const rounded = rep.confidence_by_type.task!.find((c) => c.bucket === 0.9)!;
    expect(rounded.n).toBe(33);
    expect(rounded.approveRate!).toBeLessThan(at90.approveRate!);
  });

  it("records label coverage so P0 progress is measurable", () => {
    const withMeta = label({ decision: "rejected", existence: "not_mine" });
    withMeta.decided_at = "2026-07-28T10:00:00Z";
    const rep = buildBaseline([withMeta, label({ decision: "rejected" })], "2026-07-28T00:00:00Z");
    expect(rep.decided_at_coverage).toEqual({ with: 1, without: 1 });
    expect(rep.existence_coverage).toEqual({ with: 1, without: 1 });
  });

  it("markdown names what `executed` means per type", () => {
    const md = renderBaselineMarkdown(
      buildBaseline([label({ type: "ignore", decision: "executed" })], "2026-07-28T00:00:00Z"),
    );
    // Without this, ignore=0.844 reads as "ignore is accurate".
    expect(md).toContain("人同意忽略");
  });
});
