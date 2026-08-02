import { describe, it, expect } from "vitest";
import {
  clusterKey,
  stableHash,
  unitKey,
  resolvePlanKey,
  inheritSupersededTaskIds,
} from "./unit-key.js";
import type { ActionItem } from "./action-item.js";

function card(id: string, over: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    source_message_id: `wechat:${id}`,
    action_type: "reply",
    target: { platform: "wechat", personaKey: null },
    reason: "r",
    confidence: 0.5,
    params: {},
    status: "suggested",
    created_at: "2026-07-28T00:00:00Z",
    context: { sender_handle: "张工" },
    ...over,
  };
}

describe("stableHash", () => {
  it("is deterministic and input-sensitive", () => {
    expect(stableHash("wechat::张工")).toBe(stableHash("wechat::张工"));
    expect(stableHash("wechat::张工")).not.toBe(stableHash("wechat::李工"));
    expect(stableHash("")).toMatch(/^[0-9a-f]+$/);
  });
});

describe("clusterKey", () => {
  it("platform prefix + sender; null without a sender", () => {
    expect(clusterKey(card("a"))).toBe("wechat::张工");
    expect(clusterKey(card("a", { context: undefined }))).toBeNull();
    expect(clusterKey(card("a", { context: {} }))).toBeNull();
  });
});

describe("unitKey", () => {
  it("task_id wins", () => {
    expect(unitKey(card("a", { task_id: "t9" }))).toBe("t9");
  });

  it("same sender → same key across different action ids (stable across supersede)", () => {
    const k1 = unitKey(card("a"));
    const k2 = unitKey(card("b")); // a fresh card replacing "a"
    expect(k1).toBe(k2);
    expect(k1).toBe(`__ungrouped_${stableHash("wechat::张工")}`);
  });

  it("different sender → different key", () => {
    expect(unitKey(card("a"))).not.toBe(
      unitKey(card("a", { context: { sender_handle: "李工" } })),
    );
  });

  it("no sender → falls back to the action id (never supersedes anyway)", () => {
    expect(unitKey(card("a", { context: undefined }))).toBe("__ungrouped_a");
  });
});

describe("resolvePlanKey", () => {
  it("task_id passes through", () => {
    expect(resolvePlanKey("t9", [card("a")])).toBe("t9");
  });

  it("an ungrouped identity resolves to the stable conversation key (not the action id)", () => {
    const a = card("a");
    const identity = `__ungrouped_${a.id}`;
    const stable = `__ungrouped_${stableHash("wechat::张工")}`;
    expect(resolvePlanKey(identity, [a])).toBe(stable);
    // distinct from the identity itself — the shared conversation key, not the per-card id
    expect(resolvePlanKey(identity, [a])).not.toBe(identity);
  });

  it("an unknown identity falls back to itself (defensive)", () => {
    expect(resolvePlanKey("__ungrouped_ghost", [card("a")])).toBe("__ungrouped_ghost");
  });
});

describe("inheritSupersededTaskIds", () => {
  it("a fresh card inherits the superseded same-conversation card's task_id", () => {
    const doomed = [card("old", { task_id: "task_zf" })];
    const out = inheritSupersededTaskIds([card("new")], doomed);
    expect(out[0]!.task_id).toBe("task_zf");
    expect(out[0]!.id).toBe("new");
  });

  it("fills only MISSING task_ids — never overwrites", () => {
    const doomed = [card("old", { task_id: "task_zf" })];
    const out = inheritSupersededTaskIds([card("new", { task_id: "task_own" })], doomed);
    expect(out[0]!.task_id).toBe("task_own");
  });

  it("inherits only on a key match — other senders / sender-less cards untouched", () => {
    const doomed = [card("old", { task_id: "task_zf" })];
    const other = card("new", { context: { sender_handle: "李工" } });
    const noSender = card("new2", { context: undefined });
    const out = inheritSupersededTaskIds([other, noSender], doomed);
    expect(out[0]!.task_id).toBeUndefined();
    expect(out[1]!.task_id).toBeUndefined();
  });

  it("does not mutate inputs", () => {
    const incoming = [card("new")];
    const doomed = [card("old", { task_id: "task_zf" })];
    inheritSupersededTaskIds(incoming, doomed);
    expect(incoming[0]!.task_id).toBeUndefined();
  });
});
