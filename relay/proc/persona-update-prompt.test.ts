import { describe, it, expect } from "vitest";
import { buildPersonaUpdateRequest, parseExtractedCommitments } from "./persona-update-prompt.js";

describe("persona-update prompt", () => {
  it("renders current commitments + thread into the request", () => {
    const req = buildPersonaUpdateRequest({
      name: "Michael",
      existing: [{ who: "them", what: "order the audio PCB", status: "open" }],
      thread: "me: when can you come?\nMichael: China trip, but not Oct 7 — gf birthday",
    });
    expect(req.userText).toContain("Michael");
    expect(req.userText).toContain("order the audio PCB");
    expect(req.userText).toContain("gf birthday");
  });

  it("parses valid commitments, drops malformed ones", () => {
    const out = parseExtractedCommitments({
      commitments: [
        { who: "them", what: "Visit China — NOT Oct 7 (gf birthday)", evidence: "not Oct 7" },
        { who: "leo", what: "bad who" },        // invalid who
        { who: "me", what: "" },                 // empty what
        { who: "me", what: "ship samples", evidence: "I'll send" },
      ],
    });
    expect(out.map((c) => c.what)).toEqual(["Visit China — NOT Oct 7 (gf birthday)", "ship samples"]);
  });

  it("returns [] when commitments is absent or not an array", () => {
    expect(parseExtractedCommitments({})).toEqual([]);
    expect(parseExtractedCommitments({ commitments: "nope" })).toEqual([]);
    expect(parseExtractedCommitments(null)).toEqual([]);
  });
});
