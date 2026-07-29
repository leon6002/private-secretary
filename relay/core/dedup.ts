// Dedup: per-source high-water marks so an interval poll never re-drafts an inbound it
// already processed. Survives restart because the marks live in loop-state.json.
//
//   source "slack:C123"  -> { lastTimestampMs, seenIds (recent) }
// An inbound is NEW if its timestamp is past the mark AND its id hasn't been seen.
// We keep a small ring of recent ids to handle equal-timestamp races.

export interface HighWaterMark {
  lastTimestampMs: number;
  seenIds: string[]; // bounded ring of most-recent ids
}

export type HighWaterMarks = Record<string, HighWaterMark>;

const SEEN_RING_SIZE = 50;

export function isNew(
  source: string,
  id: string,
  timestampMs: number,
  marks: HighWaterMarks,
): boolean {
  const hwm = marks[source];
  if (!hwm) return true;
  if (hwm.seenIds.includes(id)) return false;
  return timestampMs > hwm.lastTimestampMs;
}

// Returns a NEW marks object (pure) with the inbound recorded. Never mutates input.
export function advance(
  source: string,
  id: string,
  timestampMs: number,
  marks: HighWaterMarks,
): HighWaterMarks {
  const prev = marks[source] ?? { lastTimestampMs: 0, seenIds: [] };
  const seenIds = [id, ...prev.seenIds.filter((x) => x !== id)].slice(
    0,
    SEEN_RING_SIZE,
  );
  return {
    ...marks,
    [source]: {
      lastTimestampMs: Math.max(prev.lastTimestampMs, timestampMs),
      seenIds,
    },
  };
}
