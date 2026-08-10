import { describe, expect, it } from "vitest";
import { isValidTimeZone, resolveWallTime } from "./when.js";

describe("resolveWallTime", () => {
  // The meeting that started all of this: "Thursday 3pm Portugal time" on
  // 2026-08-13. Lisbon is UTC+1 in August, so the instant is 14:00Z — the
  // model variously said 13:00, 15:00 and 07:00.
  it("resolves the meeting the model kept getting wrong", () => {
    expect(resolveWallTime("2026-08-13T15:00", "Europe/Lisbon")).toBe("2026-08-13T14:00:00.000Z");
  });

  // Same wall time, same zone, different date: the offset must come from the
  // date, not from a constant. A winter offset would shift summer by an hour.
  it("uses the offset in force on that date, not a fixed one", () => {
    expect(resolveWallTime("2026-01-13T15:00", "Europe/Lisbon")).toBe("2026-01-13T15:00:00.000Z");
    expect(resolveWallTime("2026-08-13T15:00", "Europe/Lisbon")).toBe("2026-08-13T14:00:00.000Z");
  });

  it("handles zones east of UTC", () => {
    expect(resolveWallTime("2026-08-13T15:00", "Asia/Shanghai")).toBe("2026-08-13T07:00:00.000Z");
  });

  it("handles a half-hour zone", () => {
    expect(resolveWallTime("2026-08-13T15:00", "Asia/Kolkata")).toBe("2026-08-13T09:30:00.000Z");
  });

  it("handles a US zone across its DST boundary", () => {
    expect(resolveWallTime("2026-07-01T12:00", "America/New_York")).toBe("2026-07-01T16:00:00.000Z");
    expect(resolveWallTime("2026-12-01T12:00", "America/New_York")).toBe("2026-12-01T17:00:00.000Z");
  });

  // The model sometimes answers with an offset already applied; that is
  // already an instant, so there is nothing to convert.
  it("passes through a value that already carries an offset", () => {
    expect(resolveWallTime("2026-08-13T15:00:00+01:00", "Asia/Shanghai")).toBe(
      "2026-08-13T14:00:00.000Z",
    );
    expect(resolveWallTime("2026-08-13T14:00:00Z", "Europe/Lisbon")).toBe("2026-08-13T14:00:00.000Z");
  });

  it("accepts seconds and a space separator", () => {
    expect(resolveWallTime("2026-08-13 15:00:30", "Europe/Lisbon")).toBe("2026-08-13T14:00:30.000Z");
  });

  // Refusing beats guessing: a card with no time blocks approval, which is
  // recoverable. A card with the WRONG time gets approved and books it.
  it.each([
    ["", "Europe/Lisbon"],
    ["next Thursday", "Europe/Lisbon"],
    ["2026-08-13T15:00", "Not/AZone"],
    ["13/08/2026 15:00", "Europe/Lisbon"],
  ])("returns null rather than guessing for %s / %s", (wall, zone) => {
    expect(resolveWallTime(wall, zone)).toBeNull();
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects invented ones", () => {
    expect(isValidTimeZone("Europe/Lisbon")).toBe(true);
    expect(isValidTimeZone("Portugal time")).toBe(false);
  });
});
