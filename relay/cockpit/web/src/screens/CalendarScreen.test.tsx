// @vitest-environment jsdom
// CalendarScreen against a stubbed API: the week grid renders 7 day columns,
// a mocked Google event lands in its day+hour cell, queue calendar cards
// overlay only while pending (suggested/approved — never executed), and
// clicking an overlaid card navigates to the Queue with selectedId state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from "../lib/api";
import CalendarScreen from "./CalendarScreen";

const mockApiGet = vi.mocked(apiGet);

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
});

// Same week math as the screen (Sunday start, like Google) so fixtures always
// land inside the rendered week no matter when the test runs.
function weekStart(): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}
function at(weekOffset: number, hour: number, minute = 0): Date {
  const d = weekStart();
  d.setDate(d.getDate() + weekOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface CardOver {
  id: string;
  status: string;
  title: string;
  start: Date;
  end?: Date;
}
function calCard(o: CardOver) {
  return {
    id: o.id,
    action_type: "calendar",
    status: o.status,
    params: {
      title: o.title,
      start: o.start.toISOString(),
      ...(o.end ? { end: o.end.toISOString() } : {}),
    },
    created_at: "2026-08-01T00:00:00Z",
  };
}

// Wires apiGet by path: /api/calendar/events → the given events, everything
// else (the /api/state feed) → the given clusters.
function mockApi(events: unknown[], actions: unknown[] = []) {
  mockApiGet.mockImplementation((path: string) =>
    Promise.resolve(
      path.startsWith("/api/calendar/events")
        ? { events }
        : {
            clusters: actions.length
              ? [{ task_id: "t1", title: "task", actions, done: 0, total: actions.length }]
              : [],
            counts: { pending: 0, tasks: 0, awaitingManual: 0 },
          },
    ),
  );
}

function renderCalendar() {
  return render(
    <MemoryRouter initialEntries={["/calendar"]}>
      <Routes>
        <Route path="/calendar" element={<CalendarScreen />} />
        <Route path="/" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Stands in for the Queue screen: shows the location state the card click
// navigated with.
function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{JSON.stringify(loc.state)}</div>;
}

describe("CalendarScreen", () => {
  it("renders 7 day columns and the week range label", async () => {
    mockApi([]);
    const { container } = renderCalendar();

    await screen.findByTestId("week-range");
    expect(container.querySelectorAll('[data-testid^="day-col-"]')).toHaveLength(7);
    expect(screen.getByTestId("week-range").textContent).toMatch(/\w{3} \d+ – \w{3} \d+, \d{4}/);
    // Empty week, no error → the calm empty note.
    expect(screen.getByText("nothing on the calendar this week")).toBeTruthy();
  });

  // Position and SIZE both carry meaning now: the block sits in its own day
  // column, starts at its start time and is as tall as it is long.
  it("draws a timed event in its day column, sized by its duration", async () => {
    const start = at(2, 15);
    mockApi([
      {
        id: "E1",
        summary: "Sync with Michael",
        start: start.toISOString(),
        end: at(2, 17).toISOString(),
        allDay: false,
        attendees: [],
      },
      {
        id: "E2",
        summary: "Standup",
        start: at(2, 9).toISOString(),
        end: at(2, 9, 30).toISOString(),
        allDay: false,
        attendees: [],
      },
    ]);
    renderCalendar();

    await screen.findByText(/Sync with Michael/);
    const col = screen.getByTestId(`day-${dayKey(start)}`);
    expect(within(col).getByText(/Sync with Michael/)).toBeTruthy();
    expect(within(col).getByText(/15:00–17:00/)).toBeTruthy();

    // Two hours must render four times the height of thirty minutes — the
    // whole reason the cell grid was replaced.
    const long = screen.getByTestId("event-E1");
    const short = screen.getByTestId("event-E2");
    expect(parseFloat(long.style.height) / parseFloat(short.style.height)).toBeCloseTo(4);
    expect(parseFloat(long.style.top)).toBeGreaterThan(parseFloat(short.style.top));
  });

  // Concurrent items split the column instead of hiding each other — the case
  // that matters most here is a proposal landing on top of a real meeting.
  it("splits the column between an event and a proposal at the same time", async () => {
    mockApi(
      [
        {
          id: "E1",
          summary: "Existing meeting",
          start: at(2, 10).toISOString(),
          end: at(2, 11).toISOString(),
          allDay: false,
          attendees: [],
        },
      ],
      [calCard({ id: "card-s1", status: "suggested", title: "Proposed sync", start: at(2, 10), end: at(2, 11) })],
    );
    renderCalendar();

    await screen.findByText(/Proposed sync/);
    expect(screen.getByTestId("event-E1").style.width).toContain("50%");
    expect(screen.getByTestId("card-card-s1").style.width).toContain("50%");
  });

  it("overlays suggested + approved cards but never an executed one", async () => {
    mockApi(
      [],
      [
        calCard({ id: "card-s1", status: "suggested", title: "Proposed sync", start: at(3, 10), end: at(3, 11) }),
        calCard({ id: "card-a1", status: "approved", title: "Locked review", start: at(4, 11) }),
        // Executed already became a real GCal event — overlaying it too would
        // render the same thing twice.
        calCard({ id: "card-x1", status: "executed", title: "Already booked", start: at(4, 14) }),
      ],
    );
    renderCalendar();

    await screen.findByText(/Proposed sync/);
    expect(screen.getByText(/Locked review/)).toBeTruthy();
    expect(screen.queryByText(/Already booked/)).toBeNull();

    const sugCol = screen.getByTestId(`day-${dayKey(at(3, 10))}`);
    expect(within(sugCol).getByText(/suggested/)).toBeTruthy();
    const appCol = screen.getByTestId(`day-${dayKey(at(4, 11))}`);
    expect(within(appCol).getByText(/approved/)).toBeTruthy();
  });

  it("clicking an overlaid card navigates to the Queue with selectedId", async () => {
    mockApi(
      [],
      [calCard({ id: "card-s1", status: "suggested", title: "Proposed sync", start: at(3, 10) })],
    );
    renderCalendar();

    fireEvent.click(await screen.findByText(/Proposed sync/));
    expect(screen.getByTestId("probe").textContent).toBe('{"selectedId":"card-s1"}');
  });

  it("shows the error strip (and keeps calm copy) when the calendar read fails", async () => {
    mockApiGet.mockImplementation((path: string) =>
      path.startsWith("/api/calendar/events")
        ? Promise.reject(new Error("OAuth refresh failed for me@work.com: HTTP 400"))
        : Promise.resolve({ clusters: [], counts: { pending: 0, tasks: 0, awaitingManual: 0 } }),
    );
    renderCalendar();

    await screen.findByText(/calendar read failed — token expired/);
    expect(screen.getByText(/OAuth refresh failed/)).toBeTruthy();
  });
});
