import { describe, it, expect } from "vitest";
import {
  applyTaskRewrites,
  dedupTaskMints,
  groupByTask,
  normalizeTaskTitle,
  type TaskRegistry,
} from "./tasks.js";
import type { ActionItem, ActionStatus } from "./action-item.js";

// Minimal valid ActionItem; override per case. `task` type with a title is
// "ready" (no missing info) by default.
function action(
  id: string,
  over: Partial<ActionItem> = {},
): ActionItem {
  return {
    id,
    source_message_id: `m-${id}`,
    action_type: "task",
    target: {},
    reason: "r",
    confidence: 0.9,
    params: { title: "t" },
    status: "suggested" as ActionStatus,
    created_at: "2026-06-10T00:00:00Z",
    ...over,
  };
}

const registry: TaskRegistry = {
  "task-a": { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" },
  "task-b": { title: "Q3 deck", created_at: "2026-06-09T00:00:00Z" },
};

describe("groupByTask", () => {
  it("groups by task_id, titles from registry, ungrouped become their own clusters", () => {
    const clusters = groupByTask(
      [
        action("1", { task_id: "task-a" }),
        action("2", { task_id: "task-a" }),
        action("3", { task_id: "task-b" }),
        action("4"), // ungrouped
      ],
      registry,
    );
    const a = clusters.find((c) => c.task_id === "task-a")!;
    expect(a.title).toBe("Chicago trip");
    expect(a.actions.map((x) => x.id).sort()).toEqual(["1", "2"]);
    const ungrouped = clusters.filter((c) => c.task_id === null);
    expect(ungrouped).toHaveLength(1);
    expect(ungrouped[0]!.actions[0]!.id).toBe("4");
  });

  it("orders groups oldest-first by the task's anchor time (design 5A between-group)", () => {
    const clusters = groupByTask(
      [action("1", { task_id: "task-b" }), action("2", { task_id: "task-a" })],
      registry,
    );
    // task-a created 06-08 < task-b 06-09 → task-a first
    expect(clusters.map((c) => c.task_id)).toEqual(["task-a", "task-b"]);
  });

  it("within a group: ready first, needs-info last, then approved, then terminal (5A)", () => {
    const clusters = groupByTask(
      [
        action("approved", { task_id: "task-a", status: "approved" }),
        action("ready", { task_id: "task-a" }),
        // suggested reply missing draft+recipient → needs-info
        action("needsinfo", {
          task_id: "task-a",
          action_type: "reply",
          params: {},
          draft: "",
        }),
        action("done", { task_id: "task-a", status: "executed" }),
      ],
      registry,
    );
    const a = clusters.find((c) => c.task_id === "task-a")!;
    expect(a.actions.map((x) => x.id)).toEqual([
      "ready",
      "needsinfo",
      "approved",
      "done",
    ]);
  });

  it("derives progress (done/total, total excludes rejected) and status", () => {
    const clusters = groupByTask(
      [
        action("1", { task_id: "task-a", status: "executed" }),
        action("2", { task_id: "task-a", status: "rejected" }),
        action("3", { task_id: "task-a", status: "approved" }),
      ],
      registry,
    );
    const a = clusters.find((c) => c.task_id === "task-a")!;
    expect(a.done).toBe(1);
    expect(a.total).toBe(2); // rejected excluded
    expect(a.status).toBe("waiting"); // an approved member is queued to flush
  });

  it("status done when every live member is executed; open when only suggested", () => {
    const allDone = groupByTask(
      [action("1", { task_id: "task-a", status: "executed" })],
      registry,
    )[0]!;
    expect(allDone.status).toBe("done");
    const open = groupByTask([action("1", { task_id: "task-a" })], registry)[0]!;
    expect(open.status).toBe("open");
  });

  it("orphan task_id (not in registry) still clusters defensively, never drops the action", () => {
    const clusters = groupByTask([action("1", { task_id: "ghost-task-12345" })], {});
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.task_id).toBe("ghost-task-12345");
    expect(clusters[0]!.title).toContain("untitled task");
    expect(clusters[0]!.actions[0]!.id).toBe("1");
  });

  it("empty input → no clusters", () => {
    expect(groupByTask([], registry)).toEqual([]);
  });
});

describe("normalizeTaskTitle", () => {
  it("lowercases, trims, collapses internal whitespace", () => {
    expect(normalizeTaskTitle("  Chicago   Trip  ")).toBe("chicago trip");
    expect(normalizeTaskTitle("Chicago\tTrip\n")).toBe("chicago trip");
  });

  it("equal-by-normalization titles compare equal", () => {
    expect(normalizeTaskTitle("Chicago Trip")).toBe(normalizeTaskTitle("chicago trip"));
    expect(normalizeTaskTitle("Q3 Deck")).not.toBe(normalizeTaskTitle("Q3 Plan"));
  });
});

describe("dedupTaskMints (A2: stable task_id dedup)", () => {
  it("dup-id: a candidate mint whose title matches an existing task is rewritten to the existing id", () => {
    const reg: TaskRegistry = {
      "task-existing": { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" },
    };
    const candidates: TaskRegistry = {
      "task-new-uuid": { title: "Chicago trip", created_at: "2026-06-12T00:00:00Z" },
    };
    const { additions, rewrites } = dedupTaskMints(reg, candidates);
    expect(additions).toEqual({});
    expect(rewrites).toEqual({ "task-new-uuid": "task-existing" });
  });

  it("title normalization: case + whitespace differences collapse to the existing id", () => {
    const reg: TaskRegistry = {
      "task-a": { title: "Chicago Trip", created_at: "2026-06-08T00:00:00Z" },
    };
    const candidates: TaskRegistry = {
      "task-b": { title: "  chicago  trip  ", created_at: "2026-06-12T00:00:00Z" },
    };
    const { additions, rewrites } = dedupTaskMints(reg, candidates);
    expect(additions).toEqual({});
    expect(rewrites).toEqual({ "task-b": "task-a" });
  });

  it("a genuinely new title is preserved as an addition (no rewrite)", () => {
    const reg: TaskRegistry = {
      "task-a": { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" },
    };
    const candidates: TaskRegistry = {
      "task-b": { title: "Q3 deck", created_at: "2026-06-12T00:00:00Z" },
    };
    const { additions, rewrites } = dedupTaskMints(reg, candidates);
    expect(additions).toEqual(candidates);
    expect(rewrites).toEqual({});
  });

  it("idempotent re-emit of an EXISTING task_id is a no-op — not an addition, not a rewrite", () => {
    const reg: TaskRegistry = {
      "task-a": { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" },
    };
    const candidates: TaskRegistry = {
      "task-a": { title: "Chicago trip", created_at: "2026-06-12T00:00:00Z" },
    };
    const { additions, rewrites } = dedupTaskMints(reg, candidates);
    expect(additions).toEqual({});
    expect(rewrites).toEqual({});
  });

  it("dedups within the candidate batch (two new mints, same title → second rewrites to first)", () => {
    const reg: TaskRegistry = {};
    const candidates: TaskRegistry = {
      "task-x": { title: "Chicago trip", created_at: "2026-06-12T00:00:00Z" },
      "task-y": { title: "Chicago trip", created_at: "2026-06-12T00:00:01Z" },
    };
    const { additions, rewrites } = dedupTaskMints(reg, candidates);
    expect(Object.keys(additions)).toEqual(["task-x"]);
    expect(rewrites).toEqual({ "task-y": "task-x" });
  });

  it("empty inputs return empty results (no churn)", () => {
    expect(dedupTaskMints({}, {})).toEqual({ additions: {}, rewrites: {} });
  });

  it("is pure — same inputs produce the same outputs and does not mutate registry", () => {
    const reg: TaskRegistry = {
      "task-a": { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" },
    };
    const before = JSON.stringify(reg);
    const candidates: TaskRegistry = {
      "task-b": { title: "chicago trip", created_at: "2026-06-12T00:00:00Z" },
    };
    const r1 = dedupTaskMints(reg, candidates);
    const r2 = dedupTaskMints(reg, candidates);
    expect(r1).toEqual(r2);
    expect(JSON.stringify(reg)).toBe(before);
  });
});

describe("applyTaskRewrites", () => {
  it("rewrites the task_id of affected actions, leaves the others alone", () => {
    const actions = [
      action("1", { task_id: "task-new" }),
      action("2", { task_id: "task-other" }),
      action("3"),
    ];
    const result = applyTaskRewrites(actions, { "task-new": "task-existing" });
    expect(result[0]!.task_id).toBe("task-existing");
    expect(result[1]!.task_id).toBe("task-other");
    expect(result[2]!.task_id).toBeUndefined();
  });

  it("empty rewrites short-circuits (returns the same array ref)", () => {
    const actions = [action("1", { task_id: "task-a" })];
    expect(applyTaskRewrites(actions, {})).toBe(actions);
  });

  it("does not mutate the input actions", () => {
    const a = action("1", { task_id: "task-new" });
    const before = JSON.stringify(a);
    applyTaskRewrites([a], { "task-new": "task-existing" });
    expect(JSON.stringify(a)).toBe(before);
  });
});
