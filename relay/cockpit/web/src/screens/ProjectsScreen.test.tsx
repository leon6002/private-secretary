// @vitest-environment jsdom
// ProjectsScreen against a stubbed /api/projects: the sidebar groups projects
// by company with a Misc catch-all, the first project is selected by default
// and shows its live cards + needs/gaps + blockers, and selecting Misc or
// another project swaps the main pane (mirrors legacy projects.js).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from "../lib/api";
import ProjectsScreen from "./ProjectsScreen";

const mockApiGet = vi.mocked(apiGet);

const PROJECT_A = {
  id: "proj-a",
  company: "osyx",
  name: "OSYX Launch",
  goal: "Ship the launch",
  status: "on-track",
  current_state: "",
  needs: [{ need: "FCC re-test not passed", status: "gap" }],
  blockers: ["Lab booking pending"],
  cards: [
    {
      id: "c1",
      action_type: "reply",
      status: "suggested",
      headline: "Reply to the vendor",
      summary: "They asked about dates",
      next_actions: ["Send dates"],
      sender_name: "Alice Chen",
      missing_info: [],
    },
  ],
};

const PROJECT_B = {
  id: "proj-b",
  company: "taiv",
  name: "Taiv Hiring",
  goal: "",
  status: "",
  current_state: "",
  needs: [{ need: "Interview loop undefined", status: "partial" }],
  blockers: [],
  cards: [
    {
      id: "c2",
      action_type: "task",
      status: "suggested",
      headline: "Book the interview",
      summary: "",
      next_actions: [],
      sender_name: "",
      missing_info: ["date"],
    },
  ],
};

const MISC = [
  {
    id: "c9",
    action_type: "ignore",
    status: "suggested",
    headline: "Newsletter triage",
    summary: "",
    next_actions: [],
    sender_name: "",
    missing_info: [],
  },
];

function renderScreen() {
  // MemoryRouter: card rows navigate("/") on click, so a router context is
  // required even though these tests never click a card.
  return render(
    <MemoryRouter>
      <ProjectsScreen />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
});

describe("ProjectsScreen", () => {
  it("renders the sidebar (company groups + Misc) and the first project's cards, needs, and blockers", async () => {
    mockApiGet.mockResolvedValue({ projects: [PROJECT_A, PROJECT_B], misc: MISC });
    renderScreen();

    // Default selection = first project: its live card shows in the main pane.
    await screen.findByText("Reply to the vendor");

    // Sidebar: company group labels (COMPANY_LABEL map) + the Misc bucket.
    // "OSYX" shows twice — sidebar group header and the main pane's company chip.
    expect(screen.getAllByText("OSYX").length).toBeGreaterThan(0);
    expect(screen.getByText("Taiv")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Misc/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Taiv Hiring/ })).toBeTruthy();

    // Header + goal.
    expect(screen.getAllByText("OSYX Launch").length).toBeGreaterThan(0);
    expect(screen.getByText("Ship the launch")).toBeTruthy();
    expect(screen.getByText("on-track")).toBeTruthy();
    expect(screen.getByText("1 open")).toBeTruthy();

    // Needs/gaps and blockers.
    expect(screen.getByText("Open needs / gaps")).toBeTruthy();
    expect(screen.getByText("FCC re-test not passed")).toBeTruthy();
    expect(screen.getByText("gap")).toBeTruthy();
    expect(screen.getByText("Blockers")).toBeTruthy();
    expect(screen.getByText("Lab booking pending")).toBeTruthy();
  });

  it("switches to the Misc bucket when its sidebar row is clicked", async () => {
    mockApiGet.mockResolvedValue({ projects: [PROJECT_A, PROJECT_B], misc: MISC });
    renderScreen();
    await screen.findByText("Reply to the vendor");

    fireEvent.click(screen.getByRole("button", { name: /Misc/ }));

    await screen.findByText("Newsletter triage");
    expect(screen.getByText("Cards not tied to a tracked project.")).toBeTruthy();
    expect(screen.queryByText("Reply to the vendor")).toBeNull();
  });

  it("switches projects on click and flags cards with missing info", async () => {
    mockApiGet.mockResolvedValue({ projects: [PROJECT_A, PROJECT_B], misc: MISC });
    renderScreen();
    await screen.findByText("Reply to the vendor");

    fireEvent.click(screen.getByRole("button", { name: /Taiv Hiring/ }));

    await screen.findByText("Book the interview");
    expect(screen.getByText("needs info")).toBeTruthy();
    expect(screen.getByText("Interview loop undefined")).toBeTruthy();
    expect(screen.queryByText("Reply to the vendor")).toBeNull();
  });
});
