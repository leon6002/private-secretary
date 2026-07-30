import { describe, it, expect } from "vitest";
import { rankTasks, unitKey } from "./plan.js";
import type { ActionItem } from "../core/action-item.js";
import type { TaskRegistry } from "../core/tasks.js";

function card(id: string, over: Partial<ActionItem> = {}): ActionItem {
  return {
    id, source_message_id: `wechat:${id}`, action_type: "reply",
    target: {}, reason: "r", confidence: 0.5, params: {}, status: "suggested",
    created_at: "2026-07-06T00:00:00Z", headline: `head ${id}`,
    ...over,
  };
}

function jsonStub(rankings: unknown[]) {
  return { json: async () => ({ rankings }), now: () => "2026-07-06T12:00:00Z", nowMs: () => 1_000_000_000 };
}

describe("rankTasks", () => {
  it("assigns tier + rank (array order) + why, keyed by task/ungrouped", async () => {
    const cards = [card("a", { task_id: "t1" }), card("b")]; // b is ungrouped
    const registry: TaskRegistry = { t1: { title: "ZF test", created_at: "x" } };
    const r = await rankTasks(cards, registry, jsonStub([
      { key: "__ungrouped_b", tier: "A", why: "blocked on you" },
      { key: "t1", tier: "C", why: "no clock" },
    ]));
    expect(r["__ungrouped_b"]).toMatchObject({ tier: "A", rank: 0, why: "blocked on you" });
    expect(r["t1"]).toMatchObject({ tier: "C", rank: 1 });
  });

  it("carries entities through", async () => {
    const r = await rankTasks([card("a")], {}, jsonStub([
      { key: "__ungrouped_a", tier: "B", why: "w", entities: [{ kind: "flight", label: "UA102", value: "Delayed 3h" }] },
    ]));
    expect(r["__ungrouped_a"]!.entities).toEqual([{ kind: "flight", label: "UA102", value: "Delayed 3h", source: undefined }]);
  });

  it("ignores hallucinated / duplicate keys", async () => {
    const r = await rankTasks([card("a")], {}, jsonStub([
      { key: "ghost", tier: "A", why: "x" },
      { key: "__ungrouped_a", tier: "B", why: "real" },
      { key: "__ungrouped_a", tier: "D", why: "dup" },
    ]));
    expect(Object.keys(r)).toEqual(["__ungrouped_a"]);
    expect(r["__ungrouped_a"]!.tier).toBe("B"); // first wins, dup ignored
  });

  it("no-ops on empty input or no rankings", async () => {
    expect(await rankTasks([], {}, jsonStub([{ key: "x", tier: "A", why: "y" }]))).toEqual({});
    expect(await rankTasks([card("a")], {}, jsonStub([]))).toEqual({});
  });

  it("unitKey: task_id wins; standalone key is stable per conversation, id-based without a sender", () => {
    expect(unitKey(card("a", { task_id: "t9" }))).toBe("t9");
    // No sender_handle → the id-based fallback (unchanged behavior).
    expect(unitKey(card("a"))).toBe("__ungrouped_a");
    // With a sender the key derives from the conversation, not the action id,
    // so a supersede (fresh id, same sender) keeps the same unit key.
    const withSender = { context: { sender_handle: "张工" } };
    const k1 = unitKey(card("a", withSender));
    const k2 = unitKey(card("b", withSender));
    expect(k1).toMatch(/^__ungrouped_[0-9a-f]+$/);
    expect(k1).toBe(k2);
  });
});
