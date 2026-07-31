// hueFromKey — the avatar hue is a per-contact identity color shared by every
// screen, so this pins the port to the legacy public/js/state.js algorithm
// (expected values computed by hand from that exact code).
import { describe, expect, it } from "vitest";
import { hueFromKey } from "./avatar";

describe("hueFromKey", () => {
  it("matches the legacy algorithm on ASCII and CJK keys", () => {
    expect(hueFromKey("alice")).toBe(0);
    expect(hueFromKey("bob")).toBe(157);
    expect(hueFromKey("古龙")).toBe(293);
  });

  it("falls back to '?' for empty keys and always lands in [0, 360)", () => {
    expect(hueFromKey("")).toBe(hueFromKey("?"));
    for (const k of ["a", "xyz", "very-long-persona-key-123", "中文键"]) {
      const h = hueFromKey(k);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(hueFromKey(k)).toBe(h); // deterministic
    }
  });
});
