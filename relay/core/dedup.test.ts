import { describe, it, expect } from "vitest";
import { isNew, advance, type HighWaterMarks } from "./dedup.js";

describe("dedup high-water marks", () => {
  it("treats any inbound from a brand-new source as new", () => {
    expect(isNew("slack:C1", "m1", 1000, {})).toBe(true);
  });

  it("skips an inbound at or before the mark", () => {
    const marks = advance("slack:C1", "m1", 1000, {});
    expect(isNew("slack:C1", "m0", 500, marks)).toBe(false);
  });

  it("accepts a strictly newer inbound", () => {
    const marks = advance("slack:C1", "m1", 1000, marksEmpty());
    expect(isNew("slack:C1", "m2", 1500, marks)).toBe(true);
  });

  it("skips an already-seen id even at an equal timestamp (race guard)", () => {
    const marks = advance("slack:C1", "m1", 1000, {});
    expect(isNew("slack:C1", "m1", 1000, marks)).toBe(false);
  });

  // REGRESSION (mandatory): dedup survives a restart. Marks are reloaded from disk and
  // the same inbound must not be re-drafted.
  it("REGRESSION: does not re-draft after a simulated restart", () => {
    let marks: HighWaterMarks = advance("gmail:inbox", "e9", 5000, {});
    const reloaded: HighWaterMarks = JSON.parse(JSON.stringify(marks)); // disk round-trip
    expect(isNew("gmail:inbox", "e9", 5000, reloaded)).toBe(false);
  });

  it("does not mutate the input marks object", () => {
    const before: HighWaterMarks = {};
    advance("slack:C1", "m1", 1000, before);
    expect(before).toEqual({});
  });
});

function marksEmpty(): HighWaterMarks {
  return {};
}
