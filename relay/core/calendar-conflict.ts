// Pure conflict-detection logic for the `calendar` action type.
//
// Why it lives in core (not io): the executor's "do we conflict?" decision
// has to be deterministic, unit-tested, and identical across the skill,
// the cli, and the future cockpit. The Calendar API call returns a list
// of events; this module decides which of them count as conflicts with a
// proposed time slot.
//
// Inputs are intentionally minimal — just the start/end times + a
// "treat as busy?" decision per event. The caller (executor) decides
// what's busy by reading transparency / status / attendee response.

import type { CalendarEvent } from "../../relay/io/calendar-api.js";

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

export interface Conflict {
  event: CalendarEvent;
  // Window the event occupies, normalized to ms epoch for sorting + diff.
  window: TimeWindow;
}

// Parse an event's start/end (which can be dateTime + tz OR date for
// all-day) into a ms epoch window. Returns null if the event has neither
// a dateTime nor a date (Google never sends that shape, but be defensive).
export function eventWindow(event: CalendarEvent): TimeWindow | null {
  const startMs = parseEventTimePoint(event.start);
  const endMs = parseEventTimePoint(event.end);
  if (startMs == null || endMs == null) return null;
  return { startMs, endMs };
}

function parseEventTimePoint(
  point: CalendarEvent["start"] | undefined,
): number | null {
  if (!point) return null;
  if (point.dateTime) {
    const n = Date.parse(point.dateTime);
    return Number.isNaN(n) ? null : n;
  }
  if (point.date) {
    // All-day: Google's "date" is a date in the calendar's local zone;
    // we read it as UTC midnight, which gives a deterministic ordering
    // even if the wrong tz makes the absolute time wrong by a few hours.
    // The end "date" is exclusive in the Calendar API — already correct
    // for half-open window math; just turn it into ms.
    const n = Date.parse(`${point.date}T00:00:00Z`);
    if (Number.isNaN(n)) return null;
    return n;
  }
  return null;
}

// Does an event "occupy" the user, i.e. should it count as a conflict?
// - status === "cancelled" → no
// - transparency === "transparent" → no (user marked as available)
// - declined by self → no (user said no, the time is free)
// - everything else → yes
export function eventBusy(event: CalendarEvent): boolean {
  if (event.status === "cancelled") return false;
  if (event.transparency === "transparent") return false;
  // Did self decline? attendees[].self === true AND responseStatus declined.
  const selfAttendee = event.attendees?.find((a) => a.self === true);
  if (selfAttendee?.responseStatus === "declined") return false;
  return true;
}

// True if two windows overlap. We use half-open semantics: [start, end).
// A meeting that ends at 15:00 doesn't conflict with one that starts at
// 15:00. This matches every reasonable calendar UI.
export function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

// Find all events that conflict with the proposed window. Filters out
// events that shouldn't block (cancelled, transparent, self-declined).
// Returns the list of conflicts sorted by start time.
export function findConflicts(
  proposed: TimeWindow,
  events: CalendarEvent[],
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const event of events) {
    if (!eventBusy(event)) continue;
    const window = eventWindow(event);
    if (!window) continue;
    if (windowsOverlap(proposed, window)) {
      conflicts.push({ event, window });
    }
  }
  conflicts.sort((a, b) => a.window.startMs - b.window.startMs);
  return conflicts;
}

// Convenience: given a proposed CalendarEvent (the one the secretary
// wants to create) + the list returned by calendar.events.list over the
// same window, return any conflicts. Used directly by the executor.
export function findConflictsForProposed(
  proposed: CalendarEvent,
  existing: CalendarEvent[],
): Conflict[] {
  const window = eventWindow(proposed);
  if (!window) return [];
  return findConflicts(window, existing);
}
