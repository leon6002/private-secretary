import { describe, it, expect } from "vitest";
import {
  buildShadowRecord,
  DEFAULT_RUNTIME,
  shouldWriteShadowRecord,
  SHADOW_SCHEMA_VERSION,
} from "./shadow.js";
import type { ActionItem } from "./action-item.js";
import type { InboundMessage } from "./types.js";

function action(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "m1",
    action_type: "task",
    target: {},
    reason: "r",
    confidence: 0.9,
    params: { title: "t" },
    status: "suggested",
    created_at: "2026-06-13T00:00:00Z",
    ...over,
  };
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "m1",
    platform: "slack",
    senderHandle: "U1",
    timestampMs: 1781000000000,
    text: "hi",
    source: "slack:C1",
    isDirectMessage: false,
    mentionsUser: true,
    isReplyInUserThread: false,
    recipientsIncludeUser: false,
    threadAnsweredByUserAfter: false,
    ...over,
  };
}

describe("buildShadowRecord", () => {
  it("captures everything the round saw, with a stable schema version", () => {
    const rec = buildShadowRecord(
      "2026-06-13T10:00:00Z",
      [action()],
      {
        source_messages: [inbound()],
        filtered: [{ id: "m9", reason: "not-addressed" }],
        runtime: "claude-code-mvp",
      },
    );
    expect(rec.schema_version).toBe(SHADOW_SCHEMA_VERSION);
    expect(rec.round_at).toBe("2026-06-13T10:00:00Z");
    expect(rec.runtime).toBe("claude-code-mvp");
    expect(rec.source_messages).toHaveLength(1);
    expect(rec.filtered).toEqual([{ id: "m9", reason: "not-addressed" }]);
    expect(rec.actions[0]!.id).toBe("a1");
  });

  it("defaults runtime to the MVP identifier when omitted", () => {
    const rec = buildShadowRecord("t", [], {});
    expect(rec.runtime).toBe(DEFAULT_RUNTIME);
  });

  it("treats partial input as empty arrays (writer never crashes on omissions)", () => {
    const rec = buildShadowRecord("t", [], {});
    expect(rec.source_messages).toEqual([]);
    expect(rec.filtered).toEqual([]);
    expect(rec.actions).toEqual([]);
  });
});

describe("shouldWriteShadowRecord", () => {
  it("false when nothing happened (no actions, no source messages, no filtered)", () => {
    expect(shouldWriteShadowRecord([], {})).toBe(false);
  });

  it("true when actions were committed", () => {
    expect(shouldWriteShadowRecord([action()], {})).toBe(true);
  });

  it("true when source messages were seen (even if all filtered out)", () => {
    expect(shouldWriteShadowRecord([], { source_messages: [inbound()] })).toBe(true);
  });

  it("true when only filter rejections happened", () => {
    expect(
      shouldWriteShadowRecord([], { filtered: [{ id: "m1", reason: "bot-or-noreply" }] }),
    ).toBe(true);
  });
});
