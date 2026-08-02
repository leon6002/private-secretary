// Calendar screen — the cockpit's sixth screen. A read-only week view:
// real Google Calendar events (GET /api/calendar/events) as the base layer,
// with the queue's pending calendar cards (suggested / approved) overlaid at
// their proposed start time. Clicking an overlaid card jumps back to the
// Queue with that card selected (same location-state mechanism Projects uses);
// clicking a real event opens a read-only detail popover. NOTHING here writes
// — no endpoint this screen calls mutates anything.
//
// Grid decisions (deliberate simplifications, per the screen's scope):
// - Week starts Monday (the owner's business week; Google Calendar's default
//   Sunday start was the alternative).
// - Full 0–24 hour range with compact rows. A compact 6–22 band would need
//   clamping for early/late events; full-day avoids that edge case entirely.
// - A timed event is placed by its START time into that day+hour cell — no
//   duration-proportional blocks, no overlap layout. The block shows the
//   real time range, so the position is a hint, not the source of truth.
// - All-day events live in an "all-day" strip at the top of each day column.
//   Google's all-day end date is EXCLUSIVE, so a multi-day all-day event is
//   fanned out over [start, end) day cells. Timed multi-day events are not
//   fanned out — they render at their start cell only (same simplification).
// - Times render in the browser's local timezone; the RFC 3339 offsets from
//   the API carry the absolute instant.
import { useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { apiGet } from "../lib/api";
import { cn } from "../lib/cn";
import {
  CockpitFeedContext,
  useCockpitState,
} from "../lib/useCockpitState";

// Mirrors relay/cockpit/api.ts's CockpitCalendarEvent (the web app defines
// its own wire types — it never imports server-side TS).
interface CalEvent {
  id: string;
  summary: string;
  start: string; // RFC 3339 (timed) or YYYY-MM-DD (all-day)
  end: string;
  allDay: boolean;
  location?: string;
  attendees: string[];
  htmlLink?: string;
}

// A pending calendar card overlaid on the grid. Only suggested + approved
// overlay — an executed card already became a real event and would double up.
interface OverlayCard {
  id: string;
  title: string;
  start: Date;
  end: Date | null;
  status: "suggested" | "approved";
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function startOfWeek(d: Date): Date {
  // Monday-based: getDay() is Sunday-first, so (day + 6) % 7 is the offset.
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Local YYYY-MM-DD — the cell/popover key for a day column.
function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Parse an all-day YYYY-MM-DD as LOCAL midnight. `new Date("2026-08-05")`
// parses as UTC midnight, which shifts the day in timezones behind UTC.
function parseAllDay(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

// Deterministic HH:mm (no locale dependence — tests assert on these).
function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtRange(start: Date, end: Date | null): string {
  return end ? `${fmtTime(start)}–${fmtTime(end)}` : fmtTime(start);
}

export default function CalendarScreen() {
  // The App shell provides the single shared feed; rendered standalone
  // (tests) the screen falls back to its own instance.
  const shared = useContext(CockpitFeedContext);
  const own = useCockpitState({ enabled: !shared });
  const { state } = shared ?? own;

  const navigate = useNavigate();
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calError, setCalError] = useState<Error | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const today = new Date();

  // Fetch the week's real events on mount, on week navigation, and on every
  // feed poll tick (the 15s /api/state cadence doubles as this screen's
  // refresh — no second timer). A failed fetch keeps the last good events
  // and shows the error strip; it never blanks the grid.
  useEffect(() => {
    let cancelled = false;
    const start = weekStart.toISOString();
    const end = addDays(weekStart, 7).toISOString();
    apiGet<{ events: CalEvent[] }>(
      `/api/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
    )
      .then((d) => {
        if (cancelled) return;
        setEvents(d.events);
        setCalError(null);
      })
      .catch((e) => {
        if (!cancelled) setCalError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      cancelled = true;
    };
  }, [weekStart, state]);

  // ── layer 1: real events, grouped for the grid ─────────────────────
  // timed: "YYYY-MM-DD-H" → events starting in that cell. allDay: fanned out
  // over [start, end) day cells (Google's all-day end is exclusive).
  const { timed, allDay } = useMemo(() => {
    const timed = new Map<string, CalEvent[]>();
    const allDay = new Map<string, CalEvent[]>();
    for (const ev of events ?? []) {
      if (ev.allDay) {
        let cur = parseAllDay(ev.start);
        const end = ev.end ? parseAllDay(ev.end) : addDays(cur, 1);
        // Cap the fan-out so a corrupt end date can't render 10k chips.
        for (let n = 0; cur < end && n < 14; n++, cur = addDays(cur, 1)) {
          const k = dayKey(cur);
          allDay.set(k, [...(allDay.get(k) ?? []), ev]);
        }
      } else {
        const s = new Date(ev.start);
        if (Number.isNaN(s.getTime())) continue;
        const k = `${dayKey(s)}-${s.getHours()}`;
        timed.set(k, [...(timed.get(k) ?? []), ev]);
      }
    }
    return { timed, allDay };
  }, [events]);

  // ── layer 2: pending calendar cards from the queue feed ────────────
  const cards = useMemo<OverlayCard[]>(() => {
    const out: OverlayCard[] = [];
    for (const c of state?.clusters ?? []) {
      for (const a of c.actions) {
        if (a.action_type !== "calendar") continue;
        if (a.status !== "suggested" && a.status !== "approved") continue; // executed → already a real event
        const startRaw = a.params?.start;
        if (!startRaw) continue;
        const start = new Date(startRaw);
        if (Number.isNaN(start.getTime())) continue;
        const endRaw = a.params?.end;
        const end = endRaw ? new Date(endRaw) : null;
        out.push({
          id: a.id,
          title: a.params?.title || a.headline || a.reason || a.id,
          start,
          end: end && !Number.isNaN(end.getTime()) ? end : null,
          status: a.status,
        });
      }
    }
    return out;
  }, [state]);
  const cardsByCell = useMemo(() => {
    const m = new Map<string, OverlayCard[]>();
    for (const c of cards) {
      const k = `${dayKey(c.start)}-${c.start.getHours()}`;
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [cards]);

  const rangeLabel = `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${
    MONTHS[days[6]!.getMonth()]
  } ${days[6]!.getDate()}, ${days[6]!.getFullYear()}`;

  const openEvent = openEventId ? (events ?? []).find((e) => e.id === openEventId) : undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-[60px] bg-surface border-b border-outline flex items-center px-6 gap-3 flex-shrink-0">
        <h1 className="text-headline">Calendar</h1>
        <div className="flex items-center gap-1 ml-4">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            className="w-8 h-8 flex items-center justify-center border border-outline rounded hover:bg-surface-variant"
          >
            <ChevronLeft size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(startOfWeek(new Date()))}
            className="border border-outline rounded px-3 py-1.5 text-body-base hover:bg-surface-variant"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Next week"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            className="w-8 h-8 flex items-center justify-center border border-outline rounded hover:bg-surface-variant"
          >
            <ChevronRight size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div data-testid="week-range" className="text-body-medium text-on-surface-variant ml-2">
          {rangeLabel}
        </div>
      </header>

      {/* Calendar read failure (expired OAuth, network…). The grid keeps the
          last good data; the copy mirrors the Connections screen's calm tone. */}
      {calError && (
        <div className="bg-surface border-b border-outline px-6 py-2 flex-shrink-0">
          <span className="text-body-base text-error">
            calendar read failed — token expired? Re-authorize in Settings → Google.
          </span>
          <span className="text-label-sm text-on-surface-variant ml-2">{calError.message}</span>
        </div>
      )}

      <div className="flex-1 bg-background overflow-y-auto min-h-0">
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]">
          {/* Day header row — sticky so it survives scrolling the hours. */}
          <div className="sticky top-0 z-10 bg-surface border-b border-outline" />
          {days.map((d) => (
            <div
              key={dayKey(d)}
              data-testid={`day-col-${dayKey(d)}`}
              className={cn(
                "sticky top-0 z-10 bg-surface border-b border-l border-outline px-2 py-1.5 text-center",
                sameDay(d, today) && "bg-primary/10",
              )}
            >
              <div className="text-label-sm text-on-surface-variant">{WEEKDAYS[(d.getDay() + 6) % 7]}</div>
              <div className={cn("text-body-medium", sameDay(d, today) && "text-primary font-semibold")}>
                {d.getDate()}
              </div>
            </div>
          ))}

          {/* All-day strip: one row of fanned-out all-day chips. */}
          <div className="border-b border-outline px-1 py-1 text-label-sm text-on-surface-variant text-right">
            all-day
          </div>
          {days.map((d) => (
            <div
              key={dayKey(d)}
              className={cn(
                "border-b border-l border-outline px-1 py-1 flex flex-col gap-0.5 min-h-[24px]",
                sameDay(d, today) && "bg-primary/5",
              )}
            >
              {(allDay.get(dayKey(d)) ?? []).map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}
                  className="text-left text-label-sm bg-surface-variant text-on-surface rounded px-1.5 py-0.5 truncate hover:opacity-80"
                >
                  {ev.summary}
                </button>
              ))}
            </div>
          ))}

          {/* Hour rows. */}
          {HOURS.map((h) => (
            <div key={h} className="contents">
              <div className="border-b border-outline px-1 text-label-sm text-on-surface-variant text-right -translate-y-1.5">
                {h > 0 ? `${String(h).padStart(2, "0")}:00` : ""}
              </div>
              {days.map((d) => {
                const k = `${dayKey(d)}-${h}`;
                return (
                  <div
                    key={k}
                    data-testid={`cell-${k}`}
                    className={cn(
                      "relative border-b border-l border-outline min-h-[32px] p-0.5 flex flex-col gap-0.5",
                      sameDay(d, today) && "bg-primary/5",
                    )}
                  >
                    {(timed.get(k) ?? []).map((ev) => (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}
                        className="text-left text-label-sm bg-surface-variant text-on-surface rounded px-1.5 py-0.5 hover:opacity-80"
                      >
                        <span className="text-on-surface-variant">
                          {fmtRange(new Date(ev.start), ev.end ? new Date(ev.end) : null)}
                        </span>{" "}
                        {ev.summary}
                      </button>
                    ))}
                    {(cardsByCell.get(k) ?? []).map((c) => (
                      // The overlay is the queue's pending proposal, not a real
                      // event: suggested = dashed, approved = solid primary.
                      // Click jumps to the Queue with this card selected.
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => navigate("/", { state: { selectedId: c.id } })}
                        className={cn(
                          "text-left text-label-sm rounded px-1.5 py-0.5 border bg-primary/5 text-on-surface hover:bg-primary/10",
                          c.status === "suggested" ? "border-primary border-dashed" : "border-primary",
                        )}
                      >
                        <span className="text-primary">{fmtRange(c.start, c.end)}</span> {c.title}{" "}
                        <span className="text-primary uppercase text-[9px] font-semibold">{c.status}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {events && events.length === 0 && cards.length === 0 && !calError && (
          <div className="text-center text-label-sm text-on-surface-variant py-6">
            nothing on the calendar this week
          </div>
        )}
      </div>

      {/* Read-only event detail. A fixed backdrop swallows outside clicks so
          the popover closes the way every other sheet in the app does. */}
      {openEvent && (
        <>
          <div className="fixed inset-0 z-[150]" onClick={() => setOpenEventId(null)} />
          <div className="fixed z-[160] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface border border-outline rounded-lg p-4 min-w-[280px] max-w-[360px]">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="text-body-medium text-on-surface">{openEvent.summary}</div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpenEventId(null)}
                className="text-on-surface-variant hover:text-on-surface"
              >
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-base">
              <dt className="text-on-surface-variant">when</dt>
              <dd className="m-0 text-on-surface">
                {openEvent.allDay
                  ? // Google's all-day end is exclusive — show start → end-1d,
                    // collapsing to a single date for one-day events.
                    (() => {
                      const last = dayKey(addDays(parseAllDay(openEvent.end || openEvent.start), -1));
                      return last > openEvent.start
                        ? `${openEvent.start} → ${last} (all day)`
                        : `${openEvent.start} (all day)`;
                    })()
                  : fmtRange(new Date(openEvent.start), openEvent.end ? new Date(openEvent.end) : null)}
              </dd>
              {openEvent.location && (
                <>
                  <dt className="text-on-surface-variant">where</dt>
                  <dd className="m-0 text-on-surface">{openEvent.location}</dd>
                </>
              )}
              {openEvent.attendees.length > 0 && (
                <>
                  <dt className="text-on-surface-variant">who</dt>
                  <dd className="m-0 text-on-surface">{openEvent.attendees.join(", ")}</dd>
                </>
              )}
            </dl>
            {openEvent.htmlLink && (
              <a
                href={openEvent.htmlLink}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-body-base text-primary hover:underline"
              >
                open in Google Calendar <ExternalLink size={13} strokeWidth={1.75} />
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
