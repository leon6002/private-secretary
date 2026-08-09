import { describe, expect, it } from "vitest";
import { cn, TYPE_SCALE } from "./cn";

describe("cn", () => {
  // REGRESSION: twMerge only knows Tailwind's stock font sizes. Without the
  // project scale registered it classified `text-label-sm` as a COLOUR and
  // dropped it whenever a colour followed, so elements silently inherited
  // 14px/400 instead of their 12px/500. It was wrong on ~59 call sites.
  it.each(TYPE_SCALE)("keeps text-%s when a colour class follows", (size) => {
    expect(cn(`text-${size}`, "text-on-surface-variant")).toBe(
      `text-${size} text-on-surface-variant`,
    );
  });

  it("keeps the size when both are in one string", () => {
    expect(cn("text-label-sm text-primary")).toBe("text-label-sm text-primary");
  });

  it("still lets a later size win over an earlier one", () => {
    expect(cn("text-label-sm", "text-headline")).toBe("text-headline");
  });

  it("still lets a later colour win over an earlier one", () => {
    expect(cn("text-primary", "text-error")).toBe("text-error");
  });

  it("keeps resolving non-text conflicts the usual way", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
