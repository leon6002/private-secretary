// Calendar screen — the cockpit's sixth screen. A read-only week view:
// real Google Calendar events (GET /api/calendar/events) as the base layer,
// with the queue's pending calendar cards (suggested / approved) overlaid at
// their proposed start time. Clicking an overlaid card jumps back to the
// Queue with that card selected (same location-state mechanism Projects uses);
// clicking a real event opens a read-only detail popover. NOTHING here writes
// — no endpoint this screen calls mutates anything.
//
// The grid follows Google Calendar's week view, because that is the layout
// every user of this screen already knows, and because the two things it does
// that the old grid did not are the two things a week view is FOR:
// - An event's height is its length and its position is its start time, so a
//   30-minute stand-up and a 3-hour workshop no longer look identical.
//   Overlapping events split the column instead of stacking as a list. The
//   arithmetic lives in lib/week-layout.ts, tested on its own.
// - A red line marks now, so "where am I in the day" is answered by looking.
// Also Google's, for recognition rather than function: Sunday-first columns, a
// filled circle on today, 12-hour labels sitting ON the hour line, the zone
// printed once in the gutter corner, and an opening scroll to the working
// hours rather than to midnight.
//
// All-day events keep their own strip above the grid. Google's all-day end
// date is EXCLUSIVE, so a multi-day one is fanned out over [start, end).
// Times render in the browser's local timezone; the RFC 3339 offsets from the
// API carry the absolute instant.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { apiGet } from "../lib/api";
import { cn } from "../lib/cn";
import { dayFraction, layoutDay } from "../lib/week-layout";
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

// Sunday-first, matching Google's default and the row it renders.
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** Pixels per hour. Google's default zoom; below ~40 the gutter labels collide. */
const HOUR_PX = 48;
const GRID_PX = 24 * HOUR_PX;
/** Where the grid opens — nobody starts their day at 00:00. */
const INITIAL_SCROLL_HOUR = 7;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function startOfWeek(d: Date): Date {
  // Sunday-based, like Google: getDay() is already Sunday-first.
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - out.getDay());
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

// Google's gutter labels: "8 AM", "12 PM", and nothing at midnight — the line
// there is the day boundary, and a label on it reads as owning the row below.
function fmtHourLabel(h: number): string {
  if (h === 0) return "";
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
}

// "GMT+08" for the gutter corner, so nobody has to assume which clock these
// columns are in.
function zoneLabel(): string {
  const mins = -new Date().getTimezoneOffset();
  const a = Math.abs(mins);
  const mm = a % 60;
  return `GMT${mins < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}${
    mm ? `:${String(mm).padStart(2, "0")}` : ""
  }`;
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

  // ── layer 1: real events ───────────────────────────────────────────
  // Timed events become spans the layout can size and collide; all-day ones
  // are fanned out over [start, end) into the strip (Google's end is exclusive).
  const { timed, allDay } = useMemo(() => {
    const timed: Array<{ ev: CalEvent; start: Date; end: Date | null }> = [];
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
        const st = new Date(ev.start);
        if (Number.isNaN(st.getTime())) continue;
        const en = ev.end ? new Date(ev.end) : null;
        timed.push({ ev, start: st, end: en && !Number.isNaN(en.getTime()) ? en : null });
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

  // Real events and pending proposals share one column, so they must share one
  // layout pass — otherwise a proposal would be drawn straight over the meeting
  // it conflicts with, which is the one thing this screen exists to reveal.
  type Block =
    | { kind: "event"; ev: CalEvent }
    | { kind: "card"; card: OverlayCard };
  const blocksByDay = useMemo(() => {
    const all: Array<Block & { start: Date; end: Date | null }> = [
      ...timed.map((t) => ({ kind: "event" as const, ev: t.ev, start: t.start, end: t.end })),
      ...cards.map((card) => ({ kind: "card" as const, card, start: card.start, end: card.end })),
    ];
    const m = new Map<string, ReturnType<typeof layoutDay<(typeof all)[number]>>>();
    for (const d of days) {
      const k = dayKey(d);
      m.set(
        k,
        layoutDay(all.filter((b) => sameDay(b.start, d) || (b.end && b.end > d)), d),
      );
    }
    return m;
  }, [timed, cards, days]);

  // Open on the working hours. useLayoutEffect so it lands before paint —
  // scrolling after the first frame reads as the page jumping on arrival.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // A few pixels short of the hour, so that hour's gutter label — which is
    // centred ON the line — is not left half-hidden under the sticky header.
    if (scrollRef.current) scrollRef.current.scrollTop = INITIAL_SCROLL_HOUR * HOUR_PX - 10;
  }, []);

  // The now-line moves on its own clock; the feed's 15s tick is close enough
  // to a minute hand not to warrant a second timer, but not close enough to
  // trust, so this one is explicit.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

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

      <div ref={scrollRef} className="flex-1 bg-background overflow-y-auto min-h-0">
        {/* Header + all-day strip are sticky; only the hour grid scrolls,
            which is what keeps the date row readable at 6 PM. */}
        <div className="sticky top-0 z-20 bg-surface">
          <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))]">
            <div className="border-b border-outline" />
            {days.map((d) => {
              const isToday = sameDay(d, today);
              return (
                <div
                  key={dayKey(d)}
                  data-testid={`day-col-${dayKey(d)}`}
                  className="border-b border-l border-outline px-2 pt-2 pb-1 text-center"
                >
                  <div
                    className={cn(
                      "text-[11px] tracking-wide",
                      isToday ? "text-primary" : "text-on-surface-variant",
                    )}
                  >
                    {WEEKDAYS[d.getDay()]}
                  </div>
                  {/* Today is a filled disc, not coloured text — Google's
                      marker, and it survives being glanced at. */}
                  <div
                    className={cn(
                      "mx-auto mt-0.5 w-9 h-9 flex items-center justify-center rounded-full text-[22px] leading-none",
                      isToday ? "bg-primary text-white" : "text-on-surface",
                    )}
                  >
                    {d.getDate()}
                  </div>
                </div>
              );
            })}

            <div className="border-b border-outline px-1.5 py-1 text-[11px] text-on-surface-variant text-right">
              {zoneLabel()}
            </div>
            {days.map((d) => (
              <div
                key={dayKey(d)}
                className="border-b border-l border-outline px-1 py-1 flex flex-col gap-0.5 min-h-[26px]"
              >
                {(allDay.get(dayKey(d)) ?? []).map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}
                    className="text-left text-label-sm bg-emerald-600/80 text-white rounded px-1.5 py-0.5 truncate hover:opacity-90"
                  >
                    {ev.summary}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* The hour grid. Lines are a background layer and every event is
            absolutely positioned over it, which is what lets height mean
            duration and lets two meetings sit side by side. */}
        <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))]">
          <div className="relative" style={{ height: GRID_PX }}>
            {HOURS.map((h) => (
              <div
                key={h}
                className="absolute right-1.5 -translate-y-1/2 text-[11px] text-on-surface-variant"
                style={{ top: h * HOUR_PX }}
              >
                {fmtHourLabel(h)}
              </div>
            ))}
          </div>

          {days.map((d) => {
            const isToday = sameDay(d, today);
            return (
              <div
                key={dayKey(d)}
                data-testid={`day-${dayKey(d)}`}
                className="relative border-l border-outline"
                style={{ height: GRID_PX }}
              >
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-b border-outline/60"
                    style={{ top: h * HOUR_PX, height: HOUR_PX }}
                  />
                ))}

                {(blocksByDay.get(dayKey(d)) ?? []).map((p) => {
                  const b = p.item;
                  const px = p.height * GRID_PX;
                  // Under about two lines of type, stacking the title over the
                  // time clips both. Google collapses short blocks to a single
                  // line for the same reason.
                  const oneLine = px < 34;
                  const style = {
                    top: p.top * GRID_PX,
                    height: px,
                    left: `calc(${p.left * 100}% + 2px)`,
                    width: `calc(${p.width * 100}% - 4px)`,
                  };
                  if (b.kind === "event") {
                    const ev = b.ev;
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        data-testid={`event-${ev.id}`}
                        onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}
                        style={style}
                        className={cn(
                          "absolute overflow-hidden text-left rounded-md px-1.5 py-0.5",
                          "bg-[#7986cb] text-white hover:brightness-110 transition-[filter]",
                          "text-label-sm leading-tight",
                        )}
                      >
                        {oneLine ? (
                          <span className="block truncate">
                            <span className="font-medium">{ev.summary}</span>{" "}
                            <span className="opacity-90">{fmtTime(b.start)}</span>
                          </span>
                        ) : (
                          <>
                            <span className="block truncate font-medium">{ev.summary}</span>
                            <span className="block truncate opacity-90">
                              {fmtRange(b.start, b.end)}
                            </span>
                          </>
                        )}
                      </button>
                    );
                  }
                  const c = b.card;
                  // A proposal, not a booking: outlined rather than filled, so
                  // it never reads as something already on the calendar.
                  return (
                    <button
                      key={c.id}
                      type="button"
                      data-testid={`card-${c.id}`}
                      onClick={() => navigate("/", { state: { selectedId: c.id } })}
                      style={style}
                      className={cn(
                        "absolute overflow-hidden text-left rounded-md px-1.5 py-0.5",
                        "bg-primary/15 text-on-surface hover:bg-primary/25 border",
                        "text-label-sm leading-tight",
                        c.status === "suggested" ? "border-primary border-dashed" : "border-primary",
                      )}
                    >
                      {oneLine ? (
                        <span className="block truncate">
                          <span className="font-medium">{c.title}</span>{" "}
                          <span className="text-primary">{c.status}</span>
                        </span>
                      ) : (
                        <>
                          <span className="block truncate font-medium">{c.title}</span>
                          <span className="block truncate text-primary">
                            {fmtRange(c.start, c.end)} · {c.status}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}

                {isToday && (
                  <div
                    data-testid="now-line"
                    className="absolute inset-x-0 z-10 pointer-events-none"
                    style={{ top: dayFraction(now) * GRID_PX }}
                  >
                    <div className="h-px bg-red-500" />
                    <div className="absolute -left-1 -top-[5px] w-2.5 h-2.5 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            );
          })}
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
