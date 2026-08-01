// @vitest-environment jsdom
// QueueScreen against a stubbed /api/state: tier grouping + task cards +
// detail selection, j/k keyboard movement, the typed-skip flow (reason click
// completes the skip with its existence key), the edit-then-approve POST
// order (the load-bearing legacy doAction sequence), and the history drawer
// with restore. Drag-to-re-tier is NOT covered — jsdom's drag support is
// too poor; it is verified manually in the browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "../lib/api";
import QueueScreen from "./QueueScreen";

const mockApiGet = vi.mocked(apiGet);
const mockApiPost = vi.mocked(apiPost);

// ─── fixtures ────────────────────────────────────────────────────────

function makeAction(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    action_type: "reply",
    status: "suggested",
    headline: "Reply to Bob",
    reason: "Bob asked a question",
    summary: "Bob wants the numbers by Friday.",
    draft: "Hi Bob, sending them tomorrow.",
    target: { platform: "slack", personaKey: "bob" },
    context: { original_message: "can I get the numbers?", sender_handle: "bob", sent_at: "2026-07-30T10:00:00.000Z" },
    sender_name: "Bob",
    recipient_name: "Bob",
    missing_info: [],
    params: {},
    created_at: "2026-07-30T10:00:00.000Z",
    ...over,
  };
}

// Two tasks: t1 (tier A, a slack reply with a draft) and t2 (tier B, a
// Me-reminder task). Plus one done + one skipped row for the drawer.
function makeState() {
  return {
    clusters: [
      {
        task_id: "t1",
        unit_key: "t1",
        title: "Numbers for Bob",
        actions: [makeAction()],
        plan: { tier: "A", rank: 0, why: "Bob is blocked" },
        done: 0,
        total: 1,
      },
      {
        task_id: "t2",
        unit_key: "t2",
        title: "Water the plants",
        actions: [
          makeAction({
            id: "a2",
            action_type: "task",
            headline: "Water the plants",
            draft: null,
            summary: "",
            created_at: "2026-07-29T09:00:00.000Z",
          }),
        ],
        plan: { tier: "B", rank: 1, why: "" },
        done: 0,
        total: 1,
      },
    ],
    suggested: [],
    awaitingManual: [],
    done: [
      makeAction({
        id: "d1",
        action_type: "task",
        status: "executed",
        headline: "Old auto task",
        draft: null,
        params: { execution_receipt: { kind: "local", at: "2026-07-28T08:00:00.000Z" } },
      }),
    ],
    skipped: [makeAction({ id: "k1", status: "rejected", headline: "Skipped thing", draft: null })],
    sourceErrors: {},
    gate: {},
    counts: { pending: 2, tasks: 2, awaitingManual: 0 },
  };
}

function renderQueue() {
  return render(
    <MemoryRouter>
      <QueueScreen />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockApiGet.mockResolvedValue(makeState());
  mockApiPost.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
  mockApiPost.mockReset();
});

describe("QueueScreen", () => {
  it("(a) renders tier sections, task cards, and the detail of the first task; clicking a card selects its task", async () => {
    const { container } = renderQueue();

    // Tier sections (all four render, even empty, as drop targets).
    await screen.findByText("A · Do first");
    for (const label of ["B · Today", "C · This week", "D · Later"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    // Task cards in the master list.
    expect(container.querySelectorAll(".task-card")).toHaveLength(2);

    // Detail falls back to the first live cluster.
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    expect(screen.getByText("Resolution Plan")).toBeTruthy();
    // "why" shows on both the master-list card and the detail header.
    expect(screen.getAllByText("Bob is blocked").length).toBeGreaterThan(0);

    // Click the second card → its task shows in the detail pane.
    fireEvent.click(container.querySelector('.task-card[data-task="t2"]')!);
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Water the plants"));
  });

  it("(b) j/k move the selection across tasks at the task level", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));

    fireEvent.keyDown(document, { key: "j" }); // no selection → first task
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
    fireEvent.keyDown(document, { key: "j" }); // → second task
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Water the plants"));
    fireEvent.keyDown(document, { key: "j" }); // clamped at the end
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Water the plants"));
    fireEvent.keyDown(document, { key: "k" }); // back up
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));
  });

  it("(c) skip opens the reason panel; one reason click POSTs skip with the existence key", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));

    // Footer Skip targets the task's skipTarget (a1). The sub-action row has
    // its own per-row Skip; the footer's is the LAST "Skip" button in the DOM.
    const skipButtons = screen.getAllByRole("button", { name: "Skip" });
    fireEvent.click(skipButtons[skipButtons.length - 1]!);
    expect(await screen.findByText(/Why are you skipping/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Not a thing" }));
    await waitFor(() => {
      const skipCall = mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/skip");
      expect(skipCall).toBeTruthy();
      expect(skipCall![1]).toEqual({ existence: "not_a_thing", field_errors: [] });
    });
  });

  it("(d) approving while editing POSTs the draft edit BEFORE the approve", async () => {
    renderQueue();
    await waitFor(() => expect(screen.getByTestId("detail-title").textContent).toBe("Numbers for Bob"));

    // Drill into the single-card editor via the footer's Edit (the row has
    // its own Edit too; the footer's is the last one in the DOM).
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[editButtons.length - 1]!);
    const ta = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "Edited draft text" } });

    fireEvent.click(screen.getByRole("button", { name: /Approve & Send/ }));
    await waitFor(() => {
      const paths = mockApiPost.mock.calls.map(([p]) => p);
      const editIdx = paths.indexOf("/api/actions/a1/edit");
      const approveIdx = paths.indexOf("/api/actions/a1/approve");
      expect(editIdx).toBeGreaterThanOrEqual(0);
      expect(approveIdx).toBeGreaterThan(editIdx);
    });
    expect(mockApiPost.mock.calls.find(([p]) => p === "/api/actions/a1/edit")![1]).toEqual({
      draft: "Edited draft text",
    });
  });

  it("(e) the drawer lists done + skipped rows and Restore POSTs restore", async () => {
    renderQueue();
    await screen.findByText("A · Do first");

    expect(screen.getByText(/Completed \(1\) · Skipped \(1\)/)).toBeTruthy();
    expect(screen.getByText("Old auto task")).toBeTruthy();
    expect(screen.getByText("Skipped thing")).toBeTruthy();

    const restoreButtons = screen.getAllByRole("button", { name: "Restore" });
    expect(restoreButtons).toHaveLength(2);
    fireEvent.click(restoreButtons[0]!);
    await waitFor(() => {
      expect(mockApiPost.mock.calls.some(([p]) => p === "/api/actions/d1/restore")).toBe(true);
    });
  });
});
