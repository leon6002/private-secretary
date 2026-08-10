// Placing events in a Google-Calendar-style week column.
//
// The old grid dropped each event into its start HOUR cell, so a 30-minute
// stand-up and a 3-hour workshop looked identical and two overlapping meetings
// stacked as a list. Duration and collision are most of what a week view is
// for, so both are geometry here: an event's height IS its length, and
// concurrent events split the column's width the way Google's do.
//
// Pure and unit-tested on purpose — this is the part with the arithmetic.

export interface Span {
  start: Date;
  /** Null means "no end recorded"; treated as the default length below. */
  end: Date | null;
}

export interface Placed<T> {
  item: T;
  /** Fractions of the day (0–1), so the caller picks the pixel height. */
  top: number;
  height: number;
  /** Fractions of the column width (0–1). */
  left: number;
  width: number;
}

const DAY_MINUTES = 24 * 60;
/** An event with no end still needs a body to click. Google assumes 30 min. */
export const DEFAULT_EVENT_MINUTES = 30;
/** Below this a block is a sliver with unreadable text; Google clamps too. */
export const MIN_EVENT_MINUTES = 15;

function minutesInto(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Lay out one day's events.
 *
 * `dayIndex` is which day column this is; an event is clipped to it, so a
 * meeting running past midnight fills the rest of its own day rather than
 * bleeding into the next column or overflowing the grid.
 */
export function layoutDay<T extends Span>(items: readonly T[], day: Date): Array<Placed<T>> {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = dayStart + DAY_MINUTES * 60_000;

  const spans = items
    .map((item) => {
      const s = item.start.getTime();
      const e = item.end ? item.end.getTime() : s + DEFAULT_EVENT_MINUTES * 60_000;
      // Clip to this day, then enforce a minimum so short events stay usable.
      const from = Math.max(s, dayStart);
      const to = Math.min(Math.max(e, from + MIN_EVENT_MINUTES * 60_000), dayEnd);
      return { item, from, to };
    })
    .filter((x) => x.to > dayStart && x.from < dayEnd)
    // Earliest first; on a tie the longer one leads, which keeps the big block
    // on the left instead of being pushed into a sliver by a short meeting.
    .sort((a, b) => a.from - b.from || b.to - a.to);

  const out: Array<Placed<T>> = [];

  // A cluster is a run of events connected by overlap. Column count is decided
  // per cluster, not per pair: three meetings where only two ever overlap at
  // once should still be thirds if all three touch, which is what Google does.
  let cluster: typeof spans = [];
  let clusterEnd = -Infinity;

  const flush = (): void => {
    if (cluster.length === 0) return;
    // Greedy column assignment: reuse the first column that has come free.
    const colEnds: number[] = [];
    const colOf = new Map<(typeof cluster)[number], number>();
    for (const s of cluster) {
      let col = colEnds.findIndex((end) => end <= s.from);
      if (col === -1) {
        col = colEnds.length;
        colEnds.push(0);
      }
      colEnds[col] = s.to;
      colOf.set(s, col);
    }
    const cols = colEnds.length;
    for (const s of cluster) {
      const col = colOf.get(s)!;
      out.push({
        item: s.item,
        top: (s.from - dayStart) / (dayEnd - dayStart),
        height: (s.to - s.from) / (dayEnd - dayStart),
        left: col / cols,
        width: 1 / cols,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const s of spans) {
    if (s.from >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.to);
  }
  flush();
  return out;
}

/** Fraction of the day elapsed at `d`, for the current-time line. */
export function dayFraction(d: Date): number {
  return minutesInto(d) / DAY_MINUTES;
}
