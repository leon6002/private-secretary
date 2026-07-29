// P0 task 2 acceptance: every cockpit decision lands in the label ledger with a
// REAL decided_at and the human's reason. Runs against a temp state dir — never
// the live queue.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CockpitApi } from "./api.js";
import { labelsPathFor, readLabels } from "../io/labels.js";
import { loadState, saveState } from "../io/state.js";
import type { ActionItem } from "../core/action-item.js";

let dir: string;
let statePath: string;

function card(id: string, over: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    source_message_id: `wechat:${id}`,
    action_type: "task",
    target: {},
    reason: "r",
    confidence: 0.5,
    params: { title: "do the thing" },
    status: "suggested",
    created_at: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function api(): CockpitApi {
  return new CockpitApi({
    statePath,
    executor: async (a: ActionItem) => ({ action: { ...a, status: "executed" as const } }),
    now: () => "2026-07-28T12:00:00Z",
  } as unknown as ConstructorParameters<typeof CockpitApi>[0]);
}

function seed(actions: ActionItem[]): void {
  const s = loadState(statePath);
  s.actions.push(...actions);
  saveState(statePath, s);
}

function labels() {
  const p = labelsPathFor(statePath);
  return existsSync(p) ? readLabels(readFileSync(p, "utf8")) : [];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-labels-"));
  statePath = join(dir, "loop-state.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cockpit decision labels (P0)", () => {
  it("skip records the typed reason + a real decided_at", () => {
    seed([card("s1")]);
    api().skip("s1", { existence: "not_mine", field_errors: ["person"] });

    const recs = labels();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.decision).toBe("rejected");
    expect(recs[0]!.existence).toBe("not_mine");
    expect(recs[0]!.field_errors).toEqual(["person"]);
    // The whole point of P0: history had 0 decision timestamps.
    expect(recs[0]!.decided_at).toBe("2026-07-28T12:00:00Z");
    expect(recs[0]!.source_snapshot.id).toBe("s1");
  });

  it("deferred is recorded as its own verdict (so precision can exclude it)", () => {
    seed([card("d1")]);
    api().skip("d1", { existence: "deferred" });
    expect(labels()[0]!.existence).toBe("deferred");
  });

  it("skip without a reason still labels (never blocks the human)", () => {
    seed([card("s2")]);
    api().skip("s2");
    const recs = labels();
    expect(recs[0]!.decision).toBe("rejected");
    expect(recs[0]!.existence).toBeNull();
    expect(recs[0]!.decided_at).toBe("2026-07-28T12:00:00Z");
  });

  it("markDone labels executed/confirmed", () => {
    seed([card("m1")]);
    api().markDone("m1");
    const recs = labels();
    expect(recs[0]!.decision).toBe("executed");
    expect(recs[0]!.existence).toBe("confirmed");
  });

  it("edit captures WHAT changed, and the diff rides along on the decision label", () => {
    seed([card("e1", { action_type: "reply", draft: "old text", target: { platform: "wechat" } })]);
    const a = api();
    a.edit("e1", { draft: "new text", params: { title: "renamed" } });

    // The diff is accumulated on the card while it is still suggested…
    const edited = loadState(statePath).actions.find((x) => x.id === "e1")!;
    const diff = (edited.params as { _edit_diff?: Array<{ field: string }> })._edit_diff!;
    expect(diff.map((d) => d.field).sort()).toEqual(["draft", "params.title"]);
    expect(diff.find((d) => d.field === "draft")).toMatchObject({ before: "old text", after: "new text" });

    // …and lands on the label when the human finally decides.
    a.skip("e1", { existence: "not_a_thing" });
    const rec = labels()[0]!;
    expect(rec.edit_diff!.map((d) => d.field).sort()).toEqual(["draft", "params.title"]);
  });

  it("editing the same field twice keeps both steps (no silent overwrite)", () => {
    seed([card("e2", { action_type: "reply", draft: "v1", target: { platform: "wechat" } })]);
    const a = api();
    a.edit("e2", { draft: "v2" });
    a.edit("e2", { draft: "v3" });
    const edited = loadState(statePath).actions.find((x) => x.id === "e2")!;
    const diff = (edited.params as { _edit_diff?: Array<{ before: unknown; after: unknown }> })._edit_diff!;
    expect(diff).toHaveLength(2);
    expect(diff[0]).toMatchObject({ before: "v1", after: "v2" });
    expect(diff[1]).toMatchObject({ before: "v2", after: "v3" });
  });

  it("a no-op edit records no diff", () => {
    seed([card("e3", { action_type: "reply", draft: "same", target: { platform: "wechat" } })]);
    api().edit("e3", { draft: "same" });
    const edited = loadState(statePath).actions.find((x) => x.id === "e3")!;
    expect((edited.params as { _edit_diff?: unknown })._edit_diff).toBeUndefined();
  });

  it("approve labels executed once the action actually reaches executed", async () => {
    seed([card("a1")]);
    await api().approve("a1");
    const recs = labels();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.decision).toBe("executed");
    expect(recs[0]!.existence).toBe("confirmed");
  });

  it("three decisions produce three ledger lines, append-only", () => {
    seed([card("x1"), card("x2"), card("x3")]);
    const a = api();
    a.skip("x1", { existence: "not_a_thing" });
    a.markDone("x2");
    a.skip("x3", { existence: "deferred" });

    const recs = labels();
    expect(recs.map((r) => r.action_id)).toEqual(["x1", "x2", "x3"]);
    expect(recs.every((r) => r.decided_at === "2026-07-28T12:00:00Z")).toBe(true);
  });
});
