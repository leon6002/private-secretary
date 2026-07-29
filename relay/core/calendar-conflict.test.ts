import { describe, it, expect } from "vitest";
import {
  eventBusy,
  eventWindow,
  findConflicts,
  findConflictsForProposed,
  windowsOverlap,
} from "./calendar-conflict.js";
import type { CalendarEvent } from "../io/calendar-api.js";

function mk(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    start: { dateTime: "2026-06-14T15:00:00Z" },
    end: { dateTime: "2026-06-14T16:00:00Z" },
    ...over,
  };
}

describe("eventWindow", () => {
  it("parses dateTime points into ms epoch", () => {
    const w = eventWindow(mk({
      start: { dateTime: "2026-06-14T15:00:00Z" },
      end: { dateTime: "2026-06-14T16:00:00Z" },
    }));
    expect(w?.startMs).toBe(Date.parse("2026-06-14T15:00:00Z"));
    expect(w?.endMs).toBe(Date.parse("2026-06-14T16:00:00Z"));
  });

  it("parses all-day events as UTC midnight (end is exclusive)", () => {
    const w = eventWindow(mk({
      start: { date: "2026-06-14" },
      end: { date: "2026-06-15" },
    }));
    expect(w?.startMs).toBe(Date.parse("2026-06-14T00:00:00Z"));
    expect(w?.endMs).toBe(Date.parse("2026-06-15T00:00:00Z"));
  });

  it("returns null on garbage", () => {
    expect(
      eventWindow(mk({ start: {}, end: {} })),
    ).toBeNull();
  });
});

describe("eventBusy — which events block a slot", () => {
  it("cancelled → not busy", () => {
    expect(eventBusy(mk({ status: "cancelled" }))).toBe(false);
  });

  it("transparent (free time) → not busy", () => {
    expect(eventBusy(mk({ transparency: "transparent" }))).toBe(false);
  });

  it("self declined → not busy", () => {
    expect(
      eventBusy(
        mk({
          attendees: [
            { email: "leo@taiv.tv", self: true, responseStatus: "declined" },
            { email: "other@x.com", responseStatus: "accepted" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("self tentative still counts as busy (don't double-book a maybe)", () => {
    expect(
      eventBusy(
        mk({
          attendees: [{ email: "leo@taiv.tv", self: true, responseStatus: "tentative" }],
        }),
      ),
    ).toBe(true);
  });

  it("no attendees + no special flags → busy", () => {
    expect(eventBusy(mk({}))).toBe(true);
  });
});

describe("windowsOverlap — half-open semantics", () => {
  const a = { startMs: 100, endMs: 200 };
  it("touching at boundary does NOT overlap (a.end == b.start)", () => {
    expect(windowsOverlap(a, { startMs: 200, endMs: 300 })).toBe(false);
    expect(windowsOverlap({ startMs: 0, endMs: 100 }, a)).toBe(false);
  });
  it("strict overlap is detected", () => {
    expect(windowsOverlap(a, { startMs: 150, endMs: 250 })).toBe(true);
    expect(windowsOverlap(a, { startMs: 0, endMs: 150 })).toBe(true);
  });
  it("fully contained → overlap", () => {
    expect(windowsOverlap(a, { startMs: 120, endMs: 180 })).toBe(true);
    expect(windowsOverlap({ startMs: 0, endMs: 1000 }, a)).toBe(true);
  });
  it("disjoint → no overlap", () => {
    expect(windowsOverlap(a, { startMs: 300, endMs: 400 })).toBe(false);
  });
});

describe("findConflicts — proposed window vs existing events", () => {
  const proposed = {
    startMs: Date.parse("2026-06-14T15:00:00Z"),
    endMs: Date.parse("2026-06-14T16:00:00Z"),
  };

  it("returns events that genuinely overlap, skips non-busy ones", () => {
    const events = [
      mk({ id: "free-busy", start: { dateTime: "2026-06-14T15:30:00Z" }, end: { dateTime: "2026-06-14T16:30:00Z" } }),
      mk({ id: "transparent", transparency: "transparent", start: { dateTime: "2026-06-14T15:15:00Z" }, end: { dateTime: "2026-06-14T15:45:00Z" } }),
      mk({ id: "cancelled", status: "cancelled", start: { dateTime: "2026-06-14T15:30:00Z" }, end: { dateTime: "2026-06-14T16:30:00Z" } }),
      mk({ id: "self-declined", attendees: [{ email: "leo@taiv.tv", self: true, responseStatus: "declined" }], start: { dateTime: "2026-06-14T15:00:00Z" }, end: { dateTime: "2026-06-14T16:00:00Z" } }),
      mk({ id: "after", start: { dateTime: "2026-06-14T16:30:00Z" }, end: { dateTime: "2026-06-14T17:00:00Z" } }),
    ];
    const conflicts = findConflicts(proposed, events);
    expect(conflicts.map((c) => c.event.id)).toEqual(["free-busy"]);
  });

  it("returns conflicts sorted by start time", () => {
    const events = [
      mk({ id: "later", start: { dateTime: "2026-06-14T15:45:00Z" }, end: { dateTime: "2026-06-14T16:30:00Z" } }),
      mk({ id: "earlier", start: { dateTime: "2026-06-14T15:00:00Z" }, end: { dateTime: "2026-06-14T15:30:00Z" } }),
    ];
    const conflicts = findConflicts(proposed, events);
    expect(conflicts.map((c) => c.event.id)).toEqual(["earlier", "later"]);
  });

  it("boundary-touching event (ends exactly when proposed starts) is NOT a conflict", () => {
    const events = [
      mk({ id: "ends-then-mine-starts", start: { dateTime: "2026-06-14T14:00:00Z" }, end: { dateTime: "2026-06-14T15:00:00Z" } }),
    ];
    expect(findConflicts(proposed, events)).toEqual([]);
  });

  it("all-day event covering the same day counts as a conflict", () => {
    const events = [
      mk({ id: "all-day", start: { date: "2026-06-14" }, end: { date: "2026-06-15" } }),
    ];
    expect(findConflicts(proposed, events).map((c) => c.event.id)).toEqual(["all-day"]);
  });
});

describe("findConflictsForProposed — accepts a CalendarEvent directly", () => {
  it("composes eventWindow + findConflicts", () => {
    const proposed = mk({
      start: { dateTime: "2026-06-14T15:00:00Z" },
      end: { dateTime: "2026-06-14T16:00:00Z" },
    });
    const existing = [
      mk({ id: "X", start: { dateTime: "2026-06-14T15:30:00Z" }, end: { dateTime: "2026-06-14T16:30:00Z" } }),
    ];
    const conflicts = findConflictsForProposed(proposed, existing);
    expect(conflicts.map((c) => c.event.id)).toEqual(["X"]);
  });

  it("malformed proposed window returns empty (defensive)", () => {
    expect(findConflictsForProposed(mk({ start: {}, end: {} }), [])).toEqual([]);
  });
});
