import { describe, it, expect } from "vitest";
import { groupBySender, senderKey } from "./merge.js";
import type { InboundMessage } from "./types.js";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: "m1",
    platform: "slack",
    senderHandle: "alice",
    timestampMs: 1000,
    text: "hi",
    source: "slack:C1",
    isDirectMessage: true,
    mentionsUser: false,
    isReplyInUserThread: false,
    recipientsIncludeUser: false,
    threadAnsweredByUserAfter: false,
    ...overrides,
  };
}

describe("groupBySender", () => {
  it("groups same-sender messages and sorts oldest-first within a group", () => {
    const groups = groupBySender([
      msg({ id: "m2", timestampMs: 2000 }),
      msg({ id: "m1", timestampMs: 1000 }),
      msg({ id: "m3", senderHandle: "bob", timestampMs: 1500 }),
    ]);
    expect(groups.size).toBe(2);
    expect(groups.get("slack:alice")!.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(groups.get("slack:bob")!.map((m) => m.id)).toEqual(["m3"]);
  });

  it("the same handle on different platforms is a different sender key", () => {
    const groups = groupBySender([
      msg({ id: "a" }),
      msg({ id: "b", platform: "gmail", source: "gmail:inbox" }),
    ]);
    expect([...groups.keys()].sort()).toEqual(["gmail:alice", "slack:alice"]);
  });

  it("handles an empty round", () => {
    expect(groupBySender([]).size).toBe(0);
  });
});

describe("senderKey", () => {
  it("is platform-qualified", () => {
    expect(senderKey(msg())).toBe("slack:alice");
  });
});
