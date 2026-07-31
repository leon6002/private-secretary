// @vitest-environment jsdom
// ConnectionsScreen against a stubbed /api/state: dot colors + copy flip on
// sourceErrors, and a gmail:direct error yields one Reconnect button per
// mailbox=… parsed from the message (mirrors legacy connections.js).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from "../lib/api";
import ConnectionsScreen from "./ConnectionsScreen";

const mockApiGet = vi.mocked(apiGet);

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
});

describe("ConnectionsScreen", () => {
  it("renders all four cards healthy (3 green, 1 gray) with no Reconnect buttons when there are no sourceErrors", async () => {
    mockApiGet.mockResolvedValue({ sourceErrors: {} });
    const { container } = render(<ConnectionsScreen />);

    await screen.findByText("Slack · Taiv");
    expect(screen.getByText("Gmail · 4 mailboxes")).toBeTruthy();
    expect(screen.getByText("Google Calendar")).toBeTruthy();
    expect(screen.getByText("WeChat")).toBeTruthy();

    expect(container.querySelectorAll(".bg-emerald-500")).toHaveLength(3);
    expect(container.querySelectorAll(".bg-slate-300")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-error")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
    expect(screen.getByText("connected · delta via historyId")).toBeTruthy();
  });

  it("shows a Reconnect button per failing mailbox parsed from the gmail:direct error", async () => {
    mockApiGet.mockResolvedValue({
      sourceErrors: {
        "gmail:direct": {
          message:
            "mailbox=alice@example.com: OAuth refresh failed … HTTP 400; mailbox=bob@example.com: OAuth refresh failed … HTTP 400",
          at: "2026-07-31T12:00:00.000Z",
        },
      },
    });
    const { container } = render(<ConnectionsScreen />);

    await screen.findByRole("button", { name: "Reconnect alice@example.com" });
    expect(screen.getByRole("button", { name: "Reconnect bob@example.com" })).toBeTruthy();
    expect(screen.getByText("token expired — cursor frozen, nothing lost")).toBeTruthy();

    // Gmail red, Slack/Calendar still green, WeChat gray.
    expect(container.querySelectorAll(".bg-error")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-emerald-500")).toHaveLength(2);
  });
});
