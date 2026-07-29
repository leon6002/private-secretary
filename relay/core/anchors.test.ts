import { describe, it, expect } from "vitest";
import {
  validateAnchor,
  resolvableIdValid,
  filterValidAnchors,
  type Anchor,
  type SenderAnchors,
} from "./anchors.js";

// The whole safety-net contract: an anchor only survives if its `verbatim` is a
// literal source substring, and a `reference`'s resolvable_id matches its format.

describe("validateAnchor — verbatim must be a source substring", () => {
  const src = "Can you send the signed contract to Sarah by Friday 5pm? See PROJ-142.";

  it("MANDATORY: rejects a fabricated verbatim not in the source", () => {
    const a: Anchor = { type: "person", verbatim: "Jennifer", value: "jennifer-x" };
    expect(validateAnchor(a, src)).toContainEqual(expect.stringContaining("not a source substring"));
  });

  it("accepts a verbatim that IS in the source", () => {
    const a: Anchor = { type: "person", verbatim: "Sarah", value: "sarah-lee" };
    expect(validateAnchor(a, src)).toEqual([]);
  });

  it("requires a non-empty normalized value", () => {
    const a: Anchor = { type: "person", verbatim: "Sarah", value: "" };
    expect(validateAnchor(a, src)).toContainEqual(expect.stringContaining("value empty"));
  });
});

describe("validateAnchor — reference resolvable_id format (MANDATORY: fabricated id rejected)", () => {
  const src = "see PROJ-142 and https://x.com/a";
  it("rejects a fabricated jira id that fails the format", () => {
    const a: Anchor = { type: "reference", verbatim: "PROJ-142", value: "PROJ-142", ref_kind: "jira", resolvable_id: "TOTALLY-fake" };
    expect(validateAnchor(a, src)).toContainEqual(expect.stringContaining("invalid for ref_kind jira"));
  });
  it("accepts a well-formed jira id", () => {
    const a: Anchor = { type: "reference", verbatim: "PROJ-142", value: "PROJ-142", ref_kind: "jira", resolvable_id: "PROJ-142" };
    expect(validateAnchor(a, src)).toEqual([]);
  });
  it("reference without a ref_kind is invalid", () => {
    const a = { type: "reference", verbatim: "PROJ-142", value: "PROJ-142" } as Anchor;
    expect(validateAnchor(a, src)).toContainEqual(expect.stringContaining("valid ref_kind"));
  });
  it("empty resolvable_id is allowed (unresolved, not fabricated)", () => {
    const a: Anchor = { type: "reference", verbatim: "PROJ-142", value: "PROJ-142", ref_kind: "jira", resolvable_id: "" };
    expect(validateAnchor(a, src)).toEqual([]);
  });
});

describe("resolvableIdValid — per ref_kind format", () => {
  it("jira", () => { expect(resolvableIdValid("jira", "TF-12")).toBe(true); expect(resolvableIdValid("jira", "nope")).toBe(false); });
  it("url", () => { expect(resolvableIdValid("url", "https://a.co/x")).toBe(true); expect(resolvableIdValid("url", "a.co")).toBe(false); });
  it("thread ts is lenient (non-whitespace)", () => { expect(resolvableIdValid("prior_thread", "1781140064.001200")).toBe(true); expect(resolvableIdValid("prior_thread", "")).toBe(false); });
});

describe("validateAnchor — obligation ask_span must be a substring", () => {
  const src = "can you send the signed contract?";
  it("accepts ask_span present in source", () => {
    const a: Anchor = { type: "obligation", verbatim: "send the signed contract", value: "send-contract", directed_at_leo: true, ask_span: "can you send the signed contract?" };
    expect(validateAnchor(a, src)).toEqual([]);
  });
  it("rejects a fabricated ask_span", () => {
    const a: Anchor = { type: "obligation", verbatim: "send the signed contract", value: "send-contract", directed_at_leo: true, ask_span: "please wire the money" };
    expect(validateAnchor(a, src)).toContainEqual(expect.stringContaining("ask_span not a source substring"));
  });
});

// 1 positive / 1 negative per type (the §8 acceptance for the frozen 5-type contract).
describe("5-type boundaries (1 positive / 1 negative each)", () => {
  const src = "ask Sarah to review the Renesas deal, see PROJ-142, need it by Friday 5pm, can you send the contract? someone should look, that other supplier pulled out, do this soon, fyi we shipped.";
  const ok = (a: Anchor) => expect(validateAnchor(a, src)).toEqual([]);
  const bad = (a: Anchor) => expect(validateAnchor(a, src).length).toBeGreaterThan(0);

  it("person", () => {
    ok({ type: "person", verbatim: "Sarah", value: "sarah-lee" });
    bad({ type: "person", verbatim: "the intern nobody named", value: "?" }); // not in source
  });
  it("org_project", () => {
    ok({ type: "org_project", verbatim: "Renesas", value: "Renesas" });
    bad({ type: "org_project", verbatim: "Acme Corp", value: "acme" }); // not in source
  });
  it("reference", () => {
    ok({ type: "reference", verbatim: "PROJ-142", value: "PROJ-142", ref_kind: "jira", resolvable_id: "PROJ-142" });
    bad({ type: "reference", verbatim: "PROJ-142", value: "PROJ-142", ref_kind: "jira", resolvable_id: "made-up" });
  });
  it("deadline", () => {
    ok({ type: "deadline", verbatim: "Friday 5pm", value: "2026-07-17T17:00:00" });
    bad({ type: "deadline", verbatim: "next quarter maybe", value: "?" }); // not in source
  });
  it("obligation", () => {
    ok({ type: "obligation", verbatim: "can you send the contract?", value: "send-contract", directed_at_leo: true });
    bad({ type: "obligation", verbatim: "we already handled this last week", value: "?" }); // not in source
  });
});

describe("filterValidAnchors — drops invalid, keeps valid, reports dropped", () => {
  it("keeps real anchors and drops fabricated ones", () => {
    const sender: SenderAnchors = {
      sender_key: "s1", platform: "slack",
      messages: [{
        message_id: "m1",
        anchors: [
          { type: "person", verbatim: "Sarah", value: "sarah-lee" }, // valid
          { type: "person", verbatim: "Ghost", value: "ghost" }, // fabricated → dropped
        ],
      }],
    };
    const { clean, dropped } = filterValidAnchors(sender, { m1: "please loop in Sarah" });
    expect(clean.messages[0]!.anchors.map((a) => a.verbatim)).toEqual(["Sarah"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.anchor.verbatim).toBe("Ghost");
  });
});
