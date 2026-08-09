// @vitest-environment jsdom
// ConnectionsScreen against a stubbed /api/state: dot colors + copy flip on
// sourceErrors, and a gmail:direct error yields one Reconnect button per
// mailbox=… parsed from the message (mirrors legacy connections.js).
// The Slack card additionally reads /api/connections/slack, so apiGet is
// stubbed per path rather than with a single resolved value.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from "../lib/api";
import ConnectionsScreen from "./ConnectionsScreen";

const mockApiGet = vi.mocked(apiGet);

// state = whatever /api/state should answer; slack = /api/connections/slack.
function stubApi(state: unknown, slack: unknown = { kind: "none", connected: false, expiresAt: 0 }) {
  mockApiGet.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith("/api/connections/slack") ? slack : state) as never,
  );
}

const PKCE_OK = {
  account: "me@example.com",
  kind: "pkce",
  connected: true,
  team: "leotest",
  // Comfortably beyond the 3-day warning window.
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  detail: "connected · leotest",
};

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
});

describe("ConnectionsScreen", () => {
  it("renders all four cards healthy (3 green, 1 gray) with no Reconnect buttons when there are no sourceErrors", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    const { container } = render(<ConnectionsScreen />);

    await screen.findByText("Slack");
    expect(screen.getByText("Gmail · 4 mailboxes")).toBeTruthy();
    expect(screen.getByText("Google Calendar")).toBeTruthy();
    expect(screen.getByText("WeChat")).toBeTruthy();

    await screen.findByText("connected · leotest");
    expect(container.querySelectorAll(".bg-emerald-500")).toHaveLength(3);
    expect(container.querySelectorAll(".bg-slate-300")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-error")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Reconnect \S+@/ })).toBeNull();
    expect(screen.getByText("connected · delta via historyId")).toBeTruthy();
  });

  it("shows a Reconnect button per failing mailbox parsed from the gmail:direct error", async () => {
    stubApi(
      {
        sourceErrors: {
          "gmail:direct": {
            message:
              "mailbox=alice@example.com: OAuth refresh failed … HTTP 400; mailbox=bob@example.com: OAuth refresh failed … HTTP 400",
            at: "2026-07-31T12:00:00.000Z",
          },
        },
      },
      PKCE_OK,
    );
    const { container } = render(<ConnectionsScreen />);

    await screen.findByRole("button", { name: "Reconnect alice@example.com" });
    expect(screen.getByRole("button", { name: "Reconnect bob@example.com" })).toBeTruthy();
    expect(screen.getByText("token expired — cursor frozen, nothing lost")).toBeTruthy();

    // Gmail red, Slack/Calendar still green, WeChat gray.
    await screen.findByText("connected · leotest");
    expect(container.querySelectorAll(".bg-error")).toHaveLength(1);
    expect(container.querySelectorAll(".bg-emerald-500")).toHaveLength(2);
  });

  describe("Slack card", () => {
    it("offers Connect (not Reconnect) and reads gray when nothing is stored", async () => {
      stubApi({ sourceErrors: {} }, { kind: "none", connected: false, expiresAt: 0 });
      render(<ConnectionsScreen />);

      await screen.findByRole("button", { name: "Connect Slack" });
      expect(screen.getByText("not connected")).toBeTruthy();
      expect(
        screen.getByText("connect once — no Slack app to create, nothing to paste"),
      ).toBeTruthy();
    });

    it("labels the button Reconnect once a credential exists", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK);
      render(<ConnectionsScreen />);
      await screen.findByRole("button", { name: "Reconnect Slack" });
    });

    it("invites migration off a legacy hand-pasted token", async () => {
      stubApi(
        { sourceErrors: {} },
        { kind: "legacy", connected: true, expiresAt: 0, detail: "connected · legacy token (no expiry)" },
      );
      render(<ConnectionsScreen />);

      await screen.findByText("connected · legacy token (no expiry)");
      expect(
        screen.getByText("hand-pasted token · reconnect to move to the one-click flow"),
      ).toBeTruthy();
    });

    // The 30-day refresh window is the failure mode a closed laptop hits, so
    // the card has to warn while it is still fixable rather than after.
    it("goes red before expiry, not after", async () => {
      stubApi(
        { sourceErrors: {} },
        { ...PKCE_OK, expiresAt: Date.now() + 60 * 60 * 1000 },
      );
      const { container } = render(<ConnectionsScreen />);

      await screen.findByText(
        "access expires soon — it renews on its own while the daemon runs",
      );
      expect(container.querySelectorAll(".bg-error")).toHaveLength(1);
    });

    it("reports an already-expired session", async () => {
      stubApi({ sourceErrors: {} }, { ...PKCE_OK, expiresAt: Date.now() - 1000 });
      render(<ConnectionsScreen />);
      await screen.findByText("session expired");
    });

    // A degraded /api/connections/slack must not paint the card as connected.
    it("treats an unrecognised payload as not connected", async () => {
      stubApi({ sourceErrors: {} }, { nonsense: true });
      render(<ConnectionsScreen />);

      await screen.findByRole("button", { name: "Connect Slack" });
      expect(screen.getByText("not connected")).toBeTruthy();
    });
  });
});
