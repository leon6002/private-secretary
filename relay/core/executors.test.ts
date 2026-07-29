import { describe, it, expect } from "vitest";
import { canAutoExecute, ALWAYS_CONFIRM } from "./executors.js";
import type { ActionItem } from "./action-item.js";

function item(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "m1",
    action_type: "ignore",
    target: {},
    reason: "newsletter",
    confidence: 0.95,
    params: { category: "newsletter" },
    status: "suggested",
    created_at: "2026-06-10T00:00:00Z",
    ...overrides,
  };
}

describe("canAutoExecute (V1 hard rules)", () => {
  it("send-type and calendar actions NEVER auto-execute, even at confidence 1.0", () => {
    for (const type of ALWAYS_CONFIRM) {
      expect(
        canAutoExecute(
          item({
            action_type: type,
            confidence: 1.0,
            draft: "x",
            target: { personaKey: "p", platform: "gmail" },
            params: { title: "t", start: "s", end: "e", attendees: ["a"] },
          }),
        ),
      ).toBe(false);
    }
  });

  it("high-confidence ignore/task may auto-execute", () => {
    expect(canAutoExecute(item())).toBe(true);
    expect(
      canAutoExecute(item({ action_type: "task", params: { title: "do it" } })),
    ).toBe(true);
  });

  it("below the threshold: no auto-execute", () => {
    expect(canAutoExecute(item({ confidence: 0.8 }))).toBe(false);
  });

  it("missing info blocks auto-execute", () => {
    expect(canAutoExecute(item({ params: {} }))).toBe(false);
  });

  it("only suggested actions auto-execute", () => {
    expect(canAutoExecute(item({ status: "approved" }))).toBe(false);
    expect(canAutoExecute(item({ status: "executed" }))).toBe(false);
  });
});
