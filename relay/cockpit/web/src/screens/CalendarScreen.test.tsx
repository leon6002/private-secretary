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

// Same week math as the screen (Monday start) so fixtures always land inside
// the rendered week no matter when the test runs.
function monday(): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function at(weekOffset: number, hour: number): Date {
  const d = monday();
  d.setDate(d.getDate() + weekOffset);
  d.setHours(hour, 0, 0, 0);
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

  it("places a timed event in its day+hour cell", async () => {
    const start = at(2, 15); // Wednesday 15:00 local, current week
    const end = at(2, 16);
    mockApi([
      {
        id: "E1",
        summary: "Sync with Michael",
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: false,
        attendees: [],
      },
    ]);
    renderCalendar();

    await screen.findByText(/Sync with Michael/);
    const cell = screen.getByTestId(`cell-${dayKey(start)}-15`);
    expect(within(cell).getByText(/Sync with Michael/)).toBeTruthy();
    expect(within(cell).getByText(/15:00–16:00/)).toBeTruthy();
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

    const sugCell = screen.getByTestId(`cell-${dayKey(at(3, 10))}-10`);
    expect(within(sugCell).getByText("suggested")).toBeTruthy();
    const appCell = screen.getByTestId(`cell-${dayKey(at(4, 11))}-11`);
    expect(within(appCell).getByText("approved")).toBeTruthy();
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
