import { describe, it, expect } from "vitest";
import {
  approveAction,
  isCalendarRedundant,
  hasReceipt,
  InvalidActionTransition,
  markDone,
  markExecuted,
  missingInfo,
  rejectAction,
  restoreAction,
  requiresManualExecution,
  validateActionItem,
  withReceipt,
  type ActionItem,
  type ExecutionReceipt,
} from "./action-item.js";

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "m1",
    action_type: "relay",
    target: { personaKey: "wang-acme", platform: "gmail" },
    reason: "needs customer sign-off",
    confidence: 0.8,
    params: {},
    draft: "王总您好…",
    status: "suggested",
    created_at: "2026-06-10T00:00:00Z",
    ...overrides,
  };
}

describe("validateActionItem", () => {
  it("accepts a structurally valid item and defaults status to suggested", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "task",
      reason: "follow up",
      confidence: 0.7,
      params: { title: "ping vendor" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.status).toBe("suggested");
  });

  it("rejects unknown action_type, bad confidence, missing reason", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "summon",
      reason: "",
      confidence: 1.5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("action_type"))).toBe(true);
      expect(r.errors.some((e) => e.includes("confidence"))).toBe(true);
      expect(r.errors.some((e) => e.includes("reason"))).toBe(true);
    }
  });

  it("rejects a non-object", () => {
    expect(validateActionItem("nope").ok).toBe(false);
  });

  // Phase 2 T1/T2 — new optional fields accepted and carried through.
  it("accepts and carries task_id + context (T1/T2)", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "task",
      reason: "x",
      confidence: 0.5,
      params: { title: "t" },
      task_id: "task-chicago",
      context: { original_message: "hi", attachments: [], evidence_consulted: ["thread:1"] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.task_id).toBe("task-chicago");
      expect(r.item.context?.evidence_consulted).toEqual(["thread:1"]);
    }
  });

  it("accepts and carries project_id; rejects a non-string", () => {
    const ok = validateActionItem({
      source_message_id: "m1", action_type: "task", reason: "x", confidence: 0.5,
      params: { title: "t" }, project_id: "OUS-1",
    });
    expect(ok.ok && ok.item.project_id).toBe("OUS-1");
    const bad = validateActionItem({
      source_message_id: "m1", action_type: "task", reason: "x", confidence: 0.5, project_id: 7,
    });
    expect(bad.ok).toBe(false);
  });

  it("rejects an empty/whitespace task_id and a non-object context", () => {
    expect(validateActionItem({ source_message_id: "m", action_type: "task", reason: "r", confidence: 0.5, task_id: "  " }).ok).toBe(false);
    expect(validateActionItem({ source_message_id: "m", action_type: "task", reason: "r", confidence: 0.5, context: "nope" }).ok).toBe(false);
  });

  // ★ CRITICAL REGRESSION (never delete): an item WITHOUT task_id/context
  // validates to exactly the pre-T1 shape — task_id/context simply absent, no
  // other field changed. Guards the back-compat promise from the eng review.
  it("an item with no task_id/context is byte-identical to the pre-T1 shape (regression)", () => {
    const r = validateActionItem({
      source_message_id: "m1",
      action_type: "task",
      reason: "follow up",
      confidence: 0.7,
      params: { title: "ping" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect("task_id" in r.item).toBe(false);
      expect("context" in r.item).toBe(false);
      expect(r.item).toEqual({
        id: "",
        source_message_id: "m1",
        action_type: "task",
        target: {},
        reason: "follow up",
        confidence: 0.7,
        params: { title: "ping" },
        draft: undefined,
        status: "suggested",
        created_at: "",
      });
    }
  });
});

describe("markExecuting (T4 crash-safe send)", () => {
  it("writes execution_started_at on an approved item; isExecuting true until a receipt lands", async () => {
    const { markExecuting, isExecuting } = await import("./action-item.js");
    const claimed = markExecuting(approveAction(item()), "2026-06-12T00:00:00Z");
    expect(claimed.params.execution_started_at).toBe("2026-06-12T00:00:00Z");
    expect(isExecuting(claimed)).toBe(true);
    // once the receipt is written, it's no longer "executing" (send confirmed)
    const done = withReceipt(claimed, { kind: "sent", ref: "l", at: "2026-06-12T00:01:00Z" });
    expect(isExecuting(done)).toBe(false);
  });

  it("refuses to claim a non-approved item", async () => {
    const { markExecuting } = await import("./action-item.js");
    expect(() => markExecuting(item({ status: "suggested" }), "t")).toThrow(
      InvalidActionTransition,
    );
  });
});

describe("restoreAction (T6 undo)", () => {
  it("rejected → suggested", () => {
    const rej = rejectAction(item());
    expect(restoreAction(rej).status).toBe("suggested");
  });

  it("approved → suggested (un-approve before flush)", () => {
    const appr = approveAction(item());
    expect(restoreAction(appr).status).toBe("suggested");
  });

  it("refuses to restore an item with a real side effect — sent receipt (no double-send)", () => {
    const sent = withReceipt(approveAction(item()), {
      kind: "sent",
      ref: "link",
      at: "2026-06-12T00:00:00Z",
    });
    expect(() => restoreAction(sent)).toThrow(InvalidActionTransition);
  });

  it("refuses to restore an item with a real side effect — calendar_event receipt", () => {
    const booked = withReceipt(markExecuted(item({ action_type: "calendar", status: "approved" })), {
      kind: "calendar_event",
      ref: "evt-1",
      at: "2026-06-12T00:00:00Z",
    });
    expect(() => restoreAction(booked)).toThrow(InvalidActionTransition);
  });

  it("restores an executed item with a LOCAL receipt (auto-done task/ignore — no side effect)", () => {
    const done = withReceipt(markExecuted(approveAction(item({ action_type: "task", params: { title: "t" }, draft: undefined }))), {
      kind: "local",
      ref: "manual-done",
      at: "2026-06-12T00:00:00Z",
    });
    expect(restoreAction(done).status).toBe("suggested");
  });

  it("refuses to restore a suggested item", () => {
    expect(() => restoreAction(item({ status: "suggested" }))).toThrow();
  });

  it("restores a legacy executed item with NO receipt (nothing left the machine)", () => {
    const exec = markExecuted(approveAction(item()));
    expect(restoreAction(exec).status).toBe("suggested");
  });
});

describe("missingInfo", () => {
  it("relay needs recipient persona + platform + draft", () => {
    expect(
      missingInfo(item({ target: {}, draft: undefined })),
    ).toEqual(["target.personaKey", "target.platform", "draft"]);
    expect(missingInfo(item())).toEqual([]);
  });

  it("reply needs NO persona — recipient is the sender (context.sender_handle)", () => {
    // New contact, no persona resolved (personaKey null): still approvable
    // because the reply goes back to the sender we already have.
    const reply = item({
      action_type: "reply",
      target: { platform: "gmail", personaKey: null },
      draft: "Hi Alfredo, thanks…",
      context: { sender_handle: "alfredo@renesas.com" },
    });
    expect(missingInfo(reply)).toEqual([]);
  });

  it("reply flags a missing recipient only when no sender/to/persona at all", () => {
    const reply = item({
      action_type: "reply",
      target: { platform: "gmail" },
      draft: "hi",
      context: {},
      params: {},
    });
    expect(missingInfo(reply)).toEqual(["target.personaKey"]);
  });

  it("calendar needs title/start/end; attendees are optional (own-calendar block)", () => {
    const cal = item({ action_type: "calendar", params: { title: "Sync" }, draft: undefined });
    const missing = missingInfo(cal);
    expect(missing).toContain("params.start");
    expect(missing).toContain("params.end");
    expect(missing).not.toContain("params.title");
    // attendees no longer required — a WeChat-agreed meeting has no emails.
    expect(missing).not.toContain("params.attendees");
  });

  it("calendar with title/start/end is approvable with no attendees", () => {
    const cal = item({
      action_type: "calendar",
      params: { title: "实车测试", start: "2026-06-24T09:30:00+08:00", end: "2026-06-24T11:00:00+08:00" },
      draft: undefined,
    });
    expect(missingInfo(cal)).toEqual([]);
  });

  it("tool needs a tool key + the tool's required params; assignee optional", () => {
    const tool = item({
      action_type: "tool",
      target: { platform: "jira", personaKey: null },
      params: { tool: "jira", project: "BKO" },
      draft: undefined,
    });
    const missing = missingInfo(tool);
    expect(missing).toContain("params.summary");
    expect(missing).toContain("params.description");
    expect(missing).not.toContain("params.project");
    // unassigned is valid — never guessed
    expect(missing).not.toContain("params.assignee");

    // a missing tool key is flagged too
    expect(missingInfo(item({ action_type: "tool", params: {}, draft: undefined }))).toContain(
      "params.tool",
    );

    const complete = item({
      action_type: "tool",
      target: { platform: "jira", personaKey: null },
      params: { tool: "jira", project: "BKO", summary: "Homepage breaks on iOS", description: "Repro in the 2.4 build" },
      draft: undefined,
    });
    expect(missingInfo(complete)).toEqual([]);
  });

  it("tool validation honors a CUSTOM registry (a user-configured tool's required params)", () => {
    const registry = {
      jira: { key: "jira", label: "Jira", requiredParams: ["project"] },
      notion: { key: "notion", label: "Notion", requiredParams: ["title", "content"] },
    };
    const t = item({ action_type: "tool", target: {}, params: { tool: "notion" }, draft: undefined });
    expect(missingInfo(t, registry)).toContain("params.title");
    expect(missingInfo(t, registry)).toContain("params.content");
    expect(
      missingInfo({ ...t, params: { tool: "notion", title: "x", content: "y" } }, registry),
    ).toEqual([]);
  });

  it("task needs title; ignore needs category", () => {
    expect(missingInfo(item({ action_type: "task", params: {} }))).toEqual(["params.title"]);
    expect(missingInfo(item({ action_type: "ignore", params: {} }))).toEqual(["params.category"]);
  });
});

describe("status state machine", () => {
  it("suggested -> approved -> executed", () => {
    const executed = markExecuted(approveAction(item()));
    expect(executed.status).toBe("executed");
  });

  it("suggested -> rejected via skip", () => {
    expect(rejectAction(item()).status).toBe("rejected");
  });

  it("refuses to approve with missing info (no guessing)", () => {
    expect(() => approveAction(item({ draft: undefined }))).toThrow(
      InvalidActionTransition,
    );
  });

  // REGRESSION (mandatory): an executed action cannot run twice. Terminal state.
  it("REGRESSION: no double execute — executed is terminal", () => {
    const executed = markExecuted(approveAction(item()));
    expect(() => approveAction(executed)).toThrow(InvalidActionTransition);
    expect(() => markExecuted(executed)).toThrow(InvalidActionTransition);
    expect(() => rejectAction(executed)).toThrow(InvalidActionTransition);
  });

  it("cannot mark a suggested action executed (must approve first)", () => {
    expect(() => markExecuted(item())).toThrow(InvalidActionTransition);
  });

  it("cannot skip an approved action", () => {
    expect(() => rejectAction(approveAction(item()))).toThrow(InvalidActionTransition);
  });
});

describe("reply executes after approval (human-in-the-loop, not never-send)", () => {
  function reply(overrides: Partial<ActionItem> = {}): ActionItem {
    return item({
      action_type: "reply",
      target: { personaKey: "wang-acme", platform: "gmail" },
      draft: "回复内容",
      ...overrides,
    });
  }

  it("reply: suggested -> approved -> executed (sends after approval)", () => {
    expect(markExecuted(approveAction(reply())).status).toBe("executed");
  });

  it("reply still cannot execute without approval", () => {
    expect(() => markExecuted(reply())).toThrow(InvalidActionTransition);
  });

  it("markDone: a task/ignore reminder ticks straight to executed, no missing-info gate", () => {
    const t = item({ action_type: "task", params: {} }); // no params.title → would block approve
    expect(missingInfo(t)).toContain("params.title");
    expect(markDone(t).status).toBe("executed"); // still marks done
    expect(markDone(item({ action_type: "ignore", params: {} })).status).toBe("executed");
  });

  it("markDone: reply/calendar are NOT eligible (no silent tick)", () => {
    expect(() => markDone(reply())).toThrow(InvalidActionTransition);
    expect(() => markDone(item({ action_type: "calendar" }))).toThrow(InvalidActionTransition);
  });
});

describe("execution receipt (idempotency)", () => {
  const receipt: ExecutionReceipt = {
    kind: "sent",
    ref: "https://slack/msg/123",
    at: "2026-06-11T00:00:00Z",
  };

  it("hasReceipt is false until a receipt is attached", () => {
    expect(hasReceipt(item())).toBe(false);
    expect(hasReceipt(withReceipt(item(), receipt))).toBe(true);
  });

  it("withReceipt preserves other params and does not mutate input", () => {
    const base = item({ params: { foo: "bar" } });
    const after = withReceipt(base, receipt);
    expect(after.params.foo).toBe("bar");
    expect(after.params.execution_receipt).toEqual(receipt);
    expect(base.params.execution_receipt).toBeUndefined(); // input untouched
  });
});

describe("requiresManualExecution", () => {
  it("wechat AND gmail reply/relay/forward are manual (gmail connector is draft-only)", () => {
    expect(requiresManualExecution(item({ target: { personaKey: "x", platform: "wechat" } }))).toBe(true);
    // item() default target platform is gmail → manual (create_draft, user sends)
    expect(requiresManualExecution(item())).toBe(true);
    expect(
      requiresManualExecution(
        item({ action_type: "forward", target: { personaKey: "x", platform: "wechat" }, draft: undefined }),
      ),
    ).toBe(true);
  });

  it("slack sends and non-send types are not manual", () => {
    expect(requiresManualExecution(item({ target: { personaKey: "x", platform: "slack" } }))).toBe(false);
    expect(
      requiresManualExecution(item({ action_type: "calendar", params: {} })),
    ).toBe(false);
  });
});

describe("isCalendarRedundant", () => {
  const booked = item({
    id: "done1",
    action_type: "calendar",
    status: "executed",
    task_id: "t9",
    params: { title: "Q3", start: "2026-08-02T15:00:00+08:00" },
  });
  it("matches an executed calendar by exact start", () => {
    const fresh = item({ id: "f1", action_type: "calendar", params: { title: "Q3", start: "2026-08-02T15:00:00+08:00" } });
    expect(isCalendarRedundant(fresh, [booked])).toBe(true);
  });
  it("matches an executed calendar by task_id", () => {
    const fresh = item({ id: "f2", action_type: "calendar", task_id: "t9", params: { title: "Q3", start: "2026-08-03T15:00:00+08:00" } });
    expect(isCalendarRedundant(fresh, [booked])).toBe(true);
  });
  it("does NOT match a different start, a non-executed calendar, or a non-calendar action", () => {
    const other = item({ id: "f3", action_type: "calendar", params: { title: "Q3", start: "2026-08-04T15:00:00+08:00" } });
    expect(isCalendarRedundant(other, [booked])).toBe(false);
    expect(isCalendarRedundant(other, [item({ ...booked, status: "suggested" })])).toBe(false);
    expect(isCalendarRedundant(item({ id: "f4", action_type: "task" }), [booked])).toBe(false);
  });
});

describe("isCalendarRedundant — pending duplicates", () => {
  const cal = (over: Record<string, unknown> = {}) =>
    ({
      id: "x",
      action_type: "calendar",
      status: "suggested",
      params: { start: "2026-08-13T22:00:00Z", end: "2026-08-13T23:00:00Z" },
      task_id: "t1",
      ...over,
    }) as never;

  // REGRESSION: refresh re-emits a calendar card every TTL, and those cards are
  // exempt from supersede, so with only an executed-check one meeting grew a
  // new duplicate every ten minutes. Six cards for one Thursday meeting.
  it("treats a pending card for the same slot as redundant", () => {
    expect(isCalendarRedundant(cal({ id: "new" }), [cal({ id: "old" })])).toBe(true);
  });

  // The meeting moving is a real change the user must see.
  it("lets a pending card through when the start moved", () => {
    const moved = cal({ id: "new", params: { start: "2026-08-13T21:00:00Z" } });
    expect(isCalendarRedundant(moved, [cal({ id: "old" })])).toBe(false);
  });

  // Same task, different slot, already on the calendar: still a re-booking.
  it("keeps blocking a re-book of an executed event by task", () => {
    const other = cal({ id: "new", params: { start: "2026-08-14T09:00:00Z" } });
    expect(isCalendarRedundant(other, [cal({ id: "done", status: "executed" })])).toBe(true);
  });

  it("ignores cards the user already acted on", () => {
    expect(isCalendarRedundant(cal({ id: "new" }), [cal({ id: "skipped", status: "rejected" })])).toBe(false);
  });
});
