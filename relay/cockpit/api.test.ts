import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CockpitApi, type CockpitExecutor } from "./api.js";
import { loadState } from "../io/state.js";
import { activityPathFor, readActivity } from "../io/activity-log.js";
import { markExecuted, withReceipt, type ActionItem } from "../core/action-item.js";

let dir: string;
let statePath: string;
let personaDir: string;

function action(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "slack:C1:1781000000.0001",
    action_type: "reply",
    target: { platform: "slack", personaKey: "michael-dobosz" },
    reason: "answer his question",
    confidence: 0.95,
    params: {},
    draft: "sounds good",
    status: "suggested",
    created_at: "2026-06-14T00:00:00Z",
    context: { sender_handle: "U_MICHAEL" },
    ...over,
  };
}

function seed(actions: ActionItem[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      marks: {},
      actions,
      outcomes: [],
      sourceErrors: {},
      tasks: {},
      ...extra,
    }),
  );
}

// A stub executor that "sends" by stamping a sent receipt.
const sendingExecutor: CockpitExecutor = async (a) => {
  const receipt = { kind: "sent" as const, ref: "https://slack/x", at: "2026-06-14T12:00:00Z" };
  return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-api-"));
  statePath = join(dir, "loop-state.json");
  personaDir = join(dir, "personas");
  mkdirSync(personaDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function mkApi(executor: CockpitExecutor): CockpitApi {
  return new CockpitApi({ statePath, personaDir, executor, now: () => "2026-06-14T12:00:00Z" });
}

describe("getState", () => {
  it("buckets actions + computes counts", () => {
    seed([
      action({ id: "s1", task_id: "t1" }),
      action({ id: "s2", task_id: "t1" }),
      action({ id: "done1", status: "executed" }),
      action({ id: "skip1", status: "rejected" }),
      action({
        id: "manual1",
        status: "approved",
        target: { platform: "wechat", personaKey: "wang-acme" },
      }),
    ], { tasks: { t1: { title: "Chicago trip", created_at: "2026-06-08T00:00:00Z" } } });
    const api = mkApi(sendingExecutor);
    const s = api.getState();
    expect(s.counts.pending).toBe(2);
    expect(s.counts.tasks).toBe(1);
    expect(s.counts.awaitingManual).toBe(1);
    expect(s.done.map((a) => a.id)).toEqual(["done1"]);
    expect(s.skipped.map((a) => a.id)).toEqual(["skip1"]);
    expect(s.suggested[0]!.missing_info).toEqual([]);
  });

  // The executed list grows forever; getState caps the drawer's done payload
  // at the 200 most recent so the 15s poll doesn't ship unbounded history.
  it("done is capped at the 200 most recent executed actions", () => {
    seed(
      Array.from({ length: 205 }, (_, i) => action({ id: `d${i}`, status: "executed" })),
    );
    const api = mkApi(sendingExecutor);
    const s = api.getState();
    expect(s.done).toHaveLength(200);
    expect(s.done[0]!.id).toBe("d5"); // oldest 5 dropped, order preserved
    expect(s.done[199]!.id).toBe("d204");
  });

  // Regression: the Queue master list renders from clusters[].actions, not the
  // flat `suggested` array. Each cluster action MUST carry missing_info or the
  // UI crashes ("Cannot read properties of undefined (reading 'missing_info')").
  it("clusters[].actions each carry a missing_info array", () => {
    seed([
      action({ id: "ok1" }), // complete reply → no missing info
      action({ id: "needsinfo1", draft: undefined }), // reply w/o draft → missing
    ]);
    const api = mkApi(sendingExecutor);
    const clusterActions = api.getState().clusters.flatMap((c) => c.actions);
    expect(clusterActions).toHaveLength(2);
    for (const a of clusterActions) {
      expect(Array.isArray((a as { missing_info?: unknown }).missing_info)).toBe(true);
    }
    const needs = clusterActions.find((a) => a.id === "needsinfo1") as unknown as {
      missing_info: string[];
    };
    expect(needs.missing_info.length).toBeGreaterThan(0);
  });

  // sender_name fallback chain: persona-curated name → Slack display name
  // (context.sender_name, resolved at scan time) → raw sender handle.
  it("sender_name falls back persona → Slack display name → raw handle", () => {
    writeFileSync(
      join(personaDir, "michael-dobosz.yaml"),
      [
        "key: michael-dobosz",
        "display_name: Michael Dobosz",
        "handles:",
        "  slack: U_MICHAEL",
        "",
      ].join("\n"),
      "utf8",
    );
    seed([
      // persona match wins over the scan-resolved Slack name
      action({ id: "p1", context: { sender_handle: "U_MICHAEL", sender_name: "Mike" } }),
      // no persona → the Slack display name
      action({ id: "n1", context: { sender_handle: "U_UNKNOWN", sender_name: "Zack" } }),
      // neither → the raw id
      action({ id: "r1", context: { sender_handle: "U_RAW" } }),
    ]);
    const api = mkApi(sendingExecutor);
    const byId = new Map(
      api
        .getState()
        .suggested.map((a) => [a.id, (a as { sender_name?: string }).sender_name]),
    );
    expect(byId.get("p1")).toBe("Michael Dobosz");
    expect(byId.get("n1")).toBe("Zack");
    expect(byId.get("r1")).toBe("U_RAW");
  });
});

describe("approve → execute", () => {
  it("approves + executes a slack reply, persists executed + receipt", async () => {
    seed([action({ id: "a1" })]);
    const api = mkApi(sendingExecutor);
    const res = await api.approve("a1");
    expect(res.ok).toBe(true);
    expect(res.action.status).toBe("executed");
    const saved = loadState(statePath).actions.find((a) => a.id === "a1")!;
    expect(saved.status).toBe("executed");
    expect(saved.params.execution_receipt).toBeTruthy();
  });

  it("writes the executing claim BEFORE the side effect (crash-safe)", async () => {
    seed([action({ id: "a1" })]);
    let claimSeenOnDisk = false;
    const slowExecutor: CockpitExecutor = async (a, persistClaim) => {
      await persistClaim({ ...a, params: { ...a.params, execution_started_at: "2026-06-14T11:59:00Z" } });
      // at this point the claim must be on disk
      const onDisk = loadState(statePath).actions.find((x) => x.id === a.id)!;
      claimSeenOnDisk = onDisk.params.execution_started_at === "2026-06-14T11:59:00Z";
      const receipt = { kind: "sent" as const, ref: "x", at: "t" };
      return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
    };
    await mkApi(slowExecutor).approve("a1");
    expect(claimSeenOnDisk).toBe(true);
  });

  it("blocks approve on missing-info (reply with no draft)", async () => {
    seed([action({ id: "a1", draft: "" })]);
    const api = mkApi(sendingExecutor);
    await expect(api.approve("a1")).rejects.toThrow(/missing info/);
    // unchanged on disk
    expect(loadState(statePath).actions[0]!.status).toBe("suggested");
  });

  it("calendar conflict → no execute, action restored to suggested, conflicts returned", async () => {
    seed([
      action({
        id: "cal1",
        action_type: "calendar",
        draft: undefined,
        target: { platform: "gmail" },
        params: {
          title: "Sync",
          start: "2026-06-15T20:00:00Z",
          end: "2026-06-15T21:00:00Z",
          attendees: ["x@y.com"],
        },
      }),
    ]);
    const conflictExecutor: CockpitExecutor = async (a) => ({
      ok: false,
      action: a,
      awaitingManual: false,
      conflicts: [
        {
          event: { summary: "Existing", start: {}, end: {} },
          window: { startMs: 0, endMs: 1 },
        },
      ],
    });
    const res = await mkApi(conflictExecutor).approve("cal1");
    expect(res.ok).toBe(false);
    expect(res.conflicts).toHaveLength(1);
    const saved = loadState(statePath).actions.find((a) => a.id === "cal1")!;
    expect(saved.status).toBe("suggested"); // restored — user re-times
  });

  it("gmail draft → awaitingManual, stays approved, records draft id", async () => {
    seed([
      action({
        id: "g1",
        target: { platform: "gmail", personaKey: "tony-fai" },
        params: { mailbox: "leo@taiv.tv", raw_mime: "x" },
      }),
    ]);
    const draftExecutor: CockpitExecutor = async (a) => ({
      ok: true,
      action: { ...a, params: { ...a.params, gmail_draft_id: "D1" } },
      awaitingManual: true,
    });
    const res = await mkApi(draftExecutor).approve("g1");
    expect(res.awaitingManual).toBe(true);
    const saved = loadState(statePath).actions.find((a) => a.id === "g1")!;
    expect(saved.status).toBe("approved");
    expect(saved.params.gmail_draft_id).toBe("D1");
  });

  // Regression: a failing executor must NOT strand the card as "approved"
  // (which showed a false "Draft created" and blocked re-approval). It rolls
  // back to suggested so the user can fix + retry.
  it("executor throws (no receipt) → card restored to suggested, error propagates", async () => {
    seed([action({ id: "g1", target: { platform: "gmail", personaKey: null }, params: {} })]);
    const failingExecutor: CockpitExecutor = async () => {
      throw new Error("Gmail reply has no params.raw_mime");
    };
    await expect(mkApi(failingExecutor).approve("g1")).rejects.toThrow(/raw_mime/);
    const saved = loadState(statePath).actions.find((a) => a.id === "g1")!;
    expect(saved.status).toBe("suggested"); // not stranded as approved
    expect(saved.params.execution_started_at).toBeUndefined();
  });
});

describe("edit / skip / restore / markSent", () => {
  it("edit patches draft + flags _edited, stays suggested", () => {
    seed([action({ id: "a1" })]);
    const api = mkApi(sendingExecutor);
    const updated = api.edit("a1", { draft: "revised text" });
    expect(updated.draft).toBe("revised text");
    expect(updated.params._edited).toBe(true);
    expect(updated.status).toBe("suggested");
  });

  it("skip → rejected; restore → suggested", () => {
    seed([action({ id: "a1" })]);
    const api = mkApi(sendingExecutor);
    expect(api.skip("a1").status).toBe("rejected");
    expect(api.restore("a1").status).toBe("suggested");
  });

  it("restore refuses an item with a receipt (would double-send)", () => {
    seed([
      action({
        id: "a1",
        status: "approved",
        params: { execution_receipt: { kind: "sent", ref: "x", at: "t" } },
      }),
    ]);
    const api = mkApi(sendingExecutor);
    expect(() => api.restore("a1")).toThrow();
  });

  it("markSent writes receipt + executed for an awaiting-manual item", () => {
    seed([
      action({
        id: "a1",
        status: "approved",
        target: { platform: "wechat", personaKey: "wang-acme" },
      }),
    ]);
    const api = mkApi(sendingExecutor);
    const updated = api.markSent("a1", "manual");
    expect(updated.status).toBe("executed");
    expect((updated.params.execution_receipt as { ref: string }).ref).toBe("manual");
  });

  it("not-found → CockpitNotFoundError", () => {
    seed([]);
    const api = mkApi(sendingExecutor);
    expect(() => api.skip("nope")).toThrow(/not found/);
  });
});

describe("flushAutoExecute", () => {
  it("auto-executes ignore ≥0.9, leaves task and reply/relay alone", async () => {
    seed([
      action({ id: "ig", action_type: "ignore", draft: undefined, target: {}, confidence: 0.98, params: { category: "newsletter" } }),
      action({ id: "tk", action_type: "task", draft: undefined, target: {}, confidence: 0.95, params: { title: "todo" } }),
      action({ id: "rep", action_type: "reply", confidence: 0.95 }), // ALWAYS_CONFIRM
    ]);
    const localExecutor: CockpitExecutor = async (a) => {
      const receipt = { kind: "local" as const, ref: "local", at: "t" };
      return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
    };
    const api = mkApi(localExecutor);
    const n = await api.flushAutoExecute();
    expect(n).toBe(1);
    const state = loadState(statePath);
    expect(state.actions.find((a) => a.id === "ig")!.status).toBe("executed");
    // task stays put: somebody's request is never auto-completed (2026-07-31).
    expect(state.actions.find((a) => a.id === "tk")!.status).toBe("suggested");
    expect(state.actions.find((a) => a.id === "rep")!.status).toBe("suggested");
  });
});

describe("activity log (F3)", () => {
  it("cockpit decisions append one record each, in order", async () => {
    seed([
      action({ id: "a1", headline: "Q3 budget" }),
      action({ id: "a2", headline: "Lunch?" }),
    ]);
    const api = mkApi(sendingExecutor);
    api.edit("a1", { draft: "revised text" });
    api.skip("a2", { existence: "not_mine" });
    api.restore("a2");
    await api.approve("a1"); // stub executor stamps a sent receipt → executed
    const recs = readActivity(readFileSync(activityPathFor(statePath), "utf8"));
    expect(recs.map((r) => r.kind)).toEqual(["edit", "skip", "restore", "approve"]);
    expect(recs[0]!.summary).toContain("Q3 budget");
    expect(recs[0]!.summary).toContain("draft");
    expect(recs[1]!.summary).toContain("not_mine");
    expect(recs[3]!.summary).toContain("executed");
  });

  it("flushAutoExecute logs one auto-execute record (and nothing when idle)", async () => {
    seed([
      action({ id: "ig", action_type: "ignore", draft: undefined, target: {}, confidence: 0.98, params: { category: "newsletter" } }),
    ]);
    const localExecutor: CockpitExecutor = async (a) => {
      const receipt = { kind: "local" as const, ref: "local", at: "t" };
      return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
    };
    const api = mkApi(localExecutor);
    expect(await api.flushAutoExecute()).toBe(1);
    const recs = readActivity(readFileSync(activityPathFor(statePath), "utf8"));
    expect(recs.map((r) => r.kind)).toEqual(["auto-execute"]);
    expect(recs[0]!.summary).toContain("auto-executed 1 card(s)");
    // Second flush: nothing left to auto-execute → no new line.
    expect(await api.flushAutoExecute()).toBe(0);
    expect(readActivity(readFileSync(activityPathFor(statePath), "utf8"))).toHaveLength(1);
  });
});

describe("getProjects", () => {
  it("groups live cards by project_id + buckets unmatched into misc", () => {
    const projectsDir = join(dir, "projects");
    mkdirSync(projectsDir, { recursive: true });
    writeFileSync(
      join(projectsDir, "OUS-1.yaml"),
      "id: OUS-1\ncompany: oushikesi\nname: Robotics line\ngoal: build robots\nstatus: active\nneeds:\n  - need: jetson board\n    status: gap\n  - need: done thing\n    status: covered\n",
    );
    seed([
      action({ id: "p1", project_id: "OUS-1", headline: "arm demo" }),
      action({ id: "p2", project_id: "OUS-1", headline: "jetson power" }),
      action({ id: "m1", project_id: "MISC", headline: "lunch" }),
      action({ id: "m2", headline: "no project field" }), // absent → misc
    ]);
    const api = new CockpitApi({ statePath, personaDir, projectsDir, executor: sendingExecutor });
    const r = api.getProjects();
    const ous = r.projects.find((p) => p.id === "OUS-1")!;
    expect(ous.name).toBe("Robotics line");
    expect((ous.cards as unknown[]).length).toBe(2); // p1 + p2
    expect((ous.needs as unknown[]).length).toBe(1); // only the gap, covered dropped
    expect(r.misc.length).toBe(2); // m1 (MISC) + m2 (absent)
  });
});
