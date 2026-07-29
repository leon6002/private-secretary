import { describe, it, expect } from "vitest";
import {
  buildReverseIndex,
  resolveSender,
  resolveRecipient,
  inferDirectionLanguage,
  targetRequiresManualSend,
} from "./recipient-resolver.js";
import type { Persona } from "./types.js";

const personas: Persona[] = [
  {
    key: "wang-acme",
    displayName: "王总",
    relationship: "external customer, Acme decision-maker",
    handles: { wechat: "wxid_wz8821", gmail: "wang@acme.com" },
    language: "zh",
    register: "formal",
    toneNotes: "concise",
    context: "Acme rollout",
  },
  {
    key: "alice-eng",
    displayName: "Alice Chen",
    relationship: "teammate",
    handles: { slack: "U123ALICE" },
    language: "en",
    register: "casual",
    toneNotes: "direct",
    context: "eng",
  },
];

const index = buildReverseIndex(personas);

describe("resolveSender", () => {
  it("maps a known cross-platform handle to its persona", () => {
    expect(resolveSender("wxid_wz8821", index)).toBe("wang-acme");
    expect(resolveSender("wang@acme.com", index)).toBe("wang-acme");
    expect(resolveSender("U123ALICE", index)).toBe("alice-eng");
  });

  it("is case-insensitive", () => {
    expect(resolveSender("u123alice", index)).toBe("alice-eng");
  });

  it("returns null for an unknown sender", () => {
    expect(resolveSender("stranger@nowhere.com", index)).toBeNull();
  });
});

describe("resolveRecipient (ASK-not-GUESS)", () => {
  it("resolves on exactly one match", () => {
    expect(resolveRecipient(["王总"], index)).toEqual({
      status: "resolved",
      personaKey: "wang-acme",
    });
  });

  it("unresolved on zero matches — never guesses", () => {
    expect(resolveRecipient(["the supplier"], index)).toEqual({
      status: "unresolved",
      reason: "no-match",
    });
  });

  it("unresolved on ambiguous (2+ distinct personas)", () => {
    expect(resolveRecipient(["王总", "Alice Chen"], index)).toEqual({
      status: "unresolved",
      reason: "ambiguous",
    });
  });

  it("treats multiple aliases of the SAME persona as a single resolve", () => {
    expect(resolveRecipient(["wxid_wz8821", "wang@acme.com"], index)).toEqual({
      status: "resolved",
      personaKey: "wang-acme",
    });
  });
});

describe("direction + manual send helpers", () => {
  it("infers the opposite language for unknown senders", () => {
    expect(inferDirectionLanguage("zh")).toBe("en");
    expect(inferDirectionLanguage("en")).toBe("zh");
  });

  it("flags only wechat as manual send", () => {
    expect(targetRequiresManualSend("wechat")).toBe(true);
    expect(targetRequiresManualSend("slack")).toBe(false);
    expect(targetRequiresManualSend("gmail")).toBe(false);
  });
});
