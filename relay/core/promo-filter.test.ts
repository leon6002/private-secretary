import { describe, it, expect } from "vitest";
import { classifyPromo } from "./promo-filter.js";

describe("classifyPromo (Primary-only Gmail category filter)", () => {
  it("filters CATEGORY_PROMOTIONS", () => {
    const v = classifyPromo({ labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] });
    expect(v.filtered).toBe(true);
    expect(v.reason).toBe("gmail:promotions");
  });

  it("filters CATEGORY_UPDATES (newsletters/automated)", () => {
    expect(classifyPromo({ labelIds: ["CATEGORY_UPDATES"] }).filtered).toBe(true);
  });

  it("filters CATEGORY_SOCIAL and CATEGORY_FORUMS", () => {
    expect(classifyPromo({ labelIds: ["CATEGORY_SOCIAL"] }).filtered).toBe(true);
    expect(classifyPromo({ labelIds: ["CATEGORY_FORUMS"] }).filtered).toBe(true);
  });

  it("keeps explicit Primary (CATEGORY_PERSONAL)", () => {
    expect(classifyPromo({ labelIds: ["INBOX", "CATEGORY_PERSONAL"] }).filtered).toBe(false);
  });

  it("keeps mail with NO category label (Primary, unstamped) — avoids mis-filtering real mail", () => {
    expect(classifyPromo({ labelIds: ["INBOX", "IMPORTANT"] }).filtered).toBe(false);
    expect(classifyPromo({ labelIds: [] }).filtered).toBe(false);
    expect(classifyPromo({}).filtered).toBe(false);
  });

  it("filters when a non-primary category coexists with other labels", () => {
    expect(
      classifyPromo({ labelIds: ["INBOX", "IMPORTANT", "CATEGORY_PROMOTIONS"] }).filtered,
    ).toBe(true);
  });
});
