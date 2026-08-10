import { describe, expect, it } from "vitest";
import { dayFraction, layoutDay, type Span } from "./week-layout";

const DAY = new Date(2026, 7, 17); // Mon 17 Aug 2026, local
const at = (h: number, m = 0): Date => new Date(2026, 7, 17, h, m);
const span = (from: number, to: number | null): Span => ({
  start: at(from),
  end: to === null ? null : at(to),
});

// top/height are fractions of the day; 1 hour = 1/24.
const H = 1 / 24;

describe("layoutDay", () => {
  it("places an event by its start and sizes it by its length", () => {
    const [p] = layoutDay([span(9, 11)], DAY);
    expect(p!.top).toBeCloseTo(9 * H);
    expect(p!.height).toBeCloseTo(2 * H);
    expect(p!).toMatchObject({ left: 0, width: 1 });
  });

  // The whole point of the rewrite: two lengths must not look the same.
  it("gives a 3-hour event six times the height of a 30-minute one", () => {
    const [a, b] = layoutDay([span(9, 12), { start: at(14), end: at(14, 30) }], DAY);
    expect(a!.height / b!.height).toBeCloseTo(6);
  });

  it("splits overlapping events into equal columns", () => {
    const placed = layoutDay([span(9, 11), span(10, 12)], DAY);
    expect(placed.map((p) => [p.left, p.width])).toEqual([
      [0, 0.5],
      [0.5, 0.5],
    ]);
  });

  it("gives three mutually overlapping events a third each", () => {
    const placed = layoutDay([span(9, 12), span(10, 11), span(10, 13)], DAY);
    expect(placed.every((p) => Math.abs(p.width - 1 / 3) < 1e-9)).toBe(true);
    expect(new Set(placed.map((p) => p.left)).size).toBe(3);
  });

  // Column reuse: the 14:00 meeting is clear of the 9–11 one, so it belongs
  // back in column 0 rather than opening a third column and shrinking everyone.
  it("reuses a column once it is free", () => {
    const placed = layoutDay([span(9, 11), span(10, 12), span(14, 15)], DAY);
    expect(placed.find((p) => p.item.start.getHours() === 14)).toMatchObject({
      left: 0,
      width: 1,
    });
  });

  it("keeps events that never touch at full width", () => {
    const placed = layoutDay([span(9, 10), span(11, 12)], DAY);
    expect(placed.every((p) => p.width === 1)).toBe(true);
  });

  it("treats a missing end as 30 minutes rather than dropping the event", () => {
    const [p] = layoutDay([span(9, null)], DAY);
    expect(p!.height).toBeCloseTo(0.5 * H);
  });

  // A 5-minute event at 1px tall cannot be read or clicked.
  it("floors a very short event at 15 minutes of height", () => {
    const [p] = layoutDay([{ start: at(9), end: at(9, 5) }], DAY);
    expect(p!.height).toBeCloseTo(0.25 * H);
  });

  it("clips an event that runs past midnight to the end of its own column", () => {
    const [p] = layoutDay([{ start: at(23), end: new Date(2026, 7, 18, 2) }], DAY);
    expect(p!.top + p!.height).toBeCloseTo(1);
  });

  it("clips an event that started yesterday to the top of this column", () => {
    const [p] = layoutDay([{ start: new Date(2026, 7, 16, 22), end: at(2) }], DAY);
    expect(p!.top).toBe(0);
    expect(p!.height).toBeCloseTo(2 * H);
  });

  it("drops an event belonging to another day", () => {
    expect(layoutDay([{ start: new Date(2026, 7, 19, 9), end: new Date(2026, 7, 19, 10) }], DAY))
      .toHaveLength(0);
  });

  it("is empty for an empty day", () => {
    expect(layoutDay([], DAY)).toEqual([]);
  });
});

describe("dayFraction", () => {
  it("is the share of the day elapsed", () => {
    expect(dayFraction(at(0))).toBe(0);
    expect(dayFraction(at(12))).toBeCloseTo(0.5);
    expect(dayFraction(at(18, 30))).toBeCloseTo(18.5 / 24);
  });
});
