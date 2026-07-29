import { describe, it, expect, beforeEach } from "vitest";
import { refreshOpenTasks, convKey, _resetRefreshTtl, type RefreshDeps } from "./refresh.js";
import type { ActionItem } from "../core/action-item.js";
import type { DraftedAction } from "./draft-prompt.js";
import { buildRefreshRequest } from "./refresh-prompt.js";

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
    created_at: "2026-06-23T00:00:00Z",
    draft: "old draft",
    context: { sender_handle: "张工" },
    ...over,
  };
}

function deps(over: Partial<RefreshDeps> & { actions?: DraftedAction[]; thread?: string | null }): RefreshDeps {
  return {
    llm: async () => over.actions ?? [],
    resolvePersona: () => null,
    fetchThread: async () => (over.thread === undefined ? "me: ...\n张工: 周三九点半定了" : over.thread),
    now: () => "2026-06-23T12:00:00Z",
    nowMs: () => 10_000_000,
    ...over,
  };
}

beforeEach(() => _resetRefreshTtl());

const CAL: DraftedAction = {
  action_type: "calendar",
  reason: "thread agreed Wed 9:30",
  confidence: 0.8,
  params: { title: "实车测试 @安亭", start: "2026-06-24T09:30:00+08:00", end: "2026-06-24T11:00:00+08:00" },
  headline: "实车测试 周三 9:30",
  summary: "时间已定：周三 9:30 在安亭",
  next_actions: [],
};

describe("refreshOpenTasks", () => {
  it("emits a calendar action from a resolved thread, carrying task_id + conversation key", async () => {
    const c = card("m1", { task_id: "task_zf" });
    const r = await refreshOpenTasks([c], deps({ actions: [CAL] }));
    expect(r.refreshedKeys).toEqual(["wechat::张工"]);
    expect(r.newActions).toHaveLength(1);
    const a = r.newActions[0]!;
    expect(a.action_type).toBe("calendar");
    expect(a.task_id).toBe("task_zf"); // inherited → stays in the same cluster
    expect(convKey(a)).toBe("wechat::张工"); // same conversation → supersedes the old card
    expect(a.params.title).toBe("实车测试 @安亭");
    expect(a.id).not.toBe("m1"); // fresh id
  });

  it("skips a conversation whose thread is unavailable (null)", async () => {
    const r = await refreshOpenTasks([card("m1")], deps({ thread: null, actions: [CAL] }));
    expect(r.refreshedKeys).toEqual([]);
    expect(r.newActions).toEqual([]);
  });

  it("no actions from the LLM → no supersede, no new cards", async () => {
    const r = await refreshOpenTasks([card("m1")], deps({ actions: [] }));
    expect(r.refreshedKeys).toEqual([]);
    expect(r.newActions).toEqual([]);
  });

  it("drops relay/forward actions the model emits", async () => {
    const r = await refreshOpenTasks([card("m1")], deps({
      actions: [{ action_type: "relay", reason: "x", confidence: 0.5, headline: "h", summary: "s" } as DraftedAction],
    }));
    expect(r.newActions).toEqual([]);
    expect(r.refreshedKeys).toEqual([]);
  });

  it("respects the per-conversation TTL cooldown", async () => {
    const c = card("m1");
    const base = { actions: [CAL] };
    const r1 = await refreshOpenTasks([c], deps({ ...base, nowMs: () => 1000, ttlMs: 600_000 }));
    expect(r1.refreshedKeys).toEqual(["wechat::张工"]);
    // within TTL → skipped
    const r2 = await refreshOpenTasks([c], deps({ ...base, nowMs: () => 2000, ttlMs: 600_000 }));
    expect(r2.refreshedKeys).toEqual([]);
    // past TTL → refreshes again
    const r3 = await refreshOpenTasks([c], deps({ ...base, nowMs: () => 700_000, ttlMs: 600_000 }));
    expect(r3.refreshedKeys).toEqual(["wechat::张工"]);
  });

  it("caps conversations refreshed per tick", async () => {
    const cards = [
      card("m1", { context: { sender_handle: "A" }, source_message_id: "wechat:m1" }),
      card("m2", { context: { sender_handle: "B" }, source_message_id: "wechat:m2" }),
      card("m3", { context: { sender_handle: "C" }, source_message_id: "wechat:m3" }),
    ];
    const r = await refreshOpenTasks(cards, deps({ actions: [CAL], maxPerTick: 2 }));
    expect(r.refreshedKeys).toHaveLength(2);
  });
});

describe("refresh prompt: no silent no-op", () => {
  // Root cause of "my tickets are outdated": the refresh LLM had an easy escape
  // hatch — return []. Measured on a real WeChat thread, it took that exit every
  // time (23/23 conversations, 0 cards regenerated) even when the thread had
  // clearly moved on. Adding this constraint took the same card from 0 → 2
  // actions, the second being an item raised minutes earlier. An empty result
  // silently leaves a stale card in place, which is this pass's worst outcome.
  it("forbids an empty result and names the explicit alternative", () => {
    const req = buildRefreshRequest({
      card: {
        id: "c1",
        source_message_id: "wechat:x:1",
        action_type: "task",
        target: {},
        reason: "r",
        confidence: 0.5,
        params: {},
        status: "suggested",
        created_at: "2026-07-01T00:00:00Z",
      },
      thread: "me: 记得NDA",
      persona: null,
    });
    expect(req.system).toMatch(/NEVER return an empty result/);
    // The alternative must be stated, or the model just picks the empty path again.
    expect(req.system).toContain('{category:"resolved"}');
  });
});
