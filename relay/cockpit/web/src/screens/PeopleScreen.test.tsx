// @vitest-environment jsdom
// PeopleScreen against a stubbed /api/personas: the rail lists contacts (first
// 5 + a "+N" overflow chip), the first persona is selected by default with its
// Core-Knowledge fields + live tasks rendered, and clicking another contact
// swaps the profile (mirrors legacy people.js).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from "../lib/api";
import PeopleScreen from "./PeopleScreen";

const mockApiGet = vi.mocked(apiGet);

const ALICE = {
  key: "alice",
  display_name: "Alice Chen",
  identity: { role: "CFO", org: "Acme", relationship: "Peer" },
  relationship_meta: { power: "peer" },
  handles: { slack: "U1", gmail: null, wechat: null },
  communication: { language: "en", register: "casual", tone_notes: "Short and direct." },
  fields: [
    { label: "Reliability", value: "High — follows up", provenance: "manual", evidence: "Delivered Q2 early" },
  ],
  tasks: [{ id: "a1", action_type: "reply", status: "suggested", title: "Reply about budget" }],
  commitments: [{ who: "them", what: "Send the checklist", status: "open" }],
  open_threads: ["Budget approval timing"],
};

const BOB = {
  key: "bob",
  display_name: "Bob Smith",
  fields: [{ label: "Pet peeves", value: "Vague estimates", provenance: "inferred", evidence: null }],
  tasks: [],
};

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
});

describe("PeopleScreen", () => {
  it("renders the contact rail and the first persona's Core Knowledge + tasks by default", async () => {
    mockApiGet.mockResolvedValue({ personas: [ALICE, BOB] });
    render(<PeopleScreen />);

    // Rail: contacts are avatar chips identified by their title tooltip.
    await screen.findByTitle("Alice Chen");
    expect(screen.getByTitle("Bob Smith")).toBeTruthy();

    // Default selection = first persona: profile header + Core Knowledge + tasks.
    expect(screen.getByText("Core Knowledge")).toBeTruthy();
    expect(screen.getByText("Reliability")).toBeTruthy();
    expect(screen.getByText("High — follows up")).toBeTruthy();
    expect(screen.getByText("Reply about budget")).toBeTruthy();
    expect(screen.getByText("Action needed")).toBeTruthy();
    expect(screen.getByText("Send the checklist")).toBeTruthy();
    expect(screen.getByText("Budget approval timing")).toBeTruthy();
  });

  it("switches the profile when a different contact is clicked", async () => {
    mockApiGet.mockResolvedValue({ personas: [ALICE, BOB] });
    render(<PeopleScreen />);
    await screen.findByTitle("Alice Chen");

    fireEvent.click(screen.getByTitle("Bob Smith"));

    await screen.findByText("Pet peeves");
    expect(screen.getByText("Vague estimates")).toBeTruthy();
    expect(screen.getByText("No active items.")).toBeTruthy();
    expect(screen.queryByText("Reply about budget")).toBeNull();
    expect(screen.queryByText("Reliability")).toBeNull();
  });

  it("caps the rail at 5 contacts and expands via the +N overflow chip", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({
      key: `p${i + 1}`,
      display_name: `Person ${i + 1}`,
      fields: [],
      tasks: [],
    }));
    mockApiGet.mockResolvedValue({ personas: seven });
    render(<PeopleScreen />);

    await screen.findByTitle("Person 1");
    expect(screen.queryByTitle("Person 6")).toBeNull();
    const more = screen.getByTitle("Show all 7");
    expect(more.textContent).toBe("+2");

    fireEvent.click(more);
    expect(screen.getByTitle("Person 7")).toBeTruthy();
    expect(screen.queryByTitle("Show all 7")).toBeNull();
  });
});
