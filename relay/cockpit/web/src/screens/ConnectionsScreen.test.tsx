// @vitest-environment jsdom
// ConnectionsScreen: one table row per connector, driven by /api/state's
// sourceErrors plus /api/connections/slack. Covers the three row states
// (connected / needs attention / manual), the per-mailbox Gmail Reconnect
// buttons parsed out of the gmail:direct error, and the filter tabs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from "../lib/api";
import ConnectionsScreen from "./ConnectionsScreen";

const mockApiGet = vi.mocked(apiGet);

// Jira/Notion rows are generated from the MCP tool registry, so the tools
// endpoint is stubbed alongside /api/state and /api/connections/slack.
const TOOLS = {
  effective: {
    jira: {
      key: "jira",
      label: "Jira",
      config: { type: "mcp", url: "https://mcp.atlassian.com/v1/mcp/authv2" },
    },
  },
  authorized: { jira: true },
};

function stubApi(
  state: unknown,
  slack: unknown = { kind: "none", connected: false, expiresAt: 0, reconnectBy: 0 },
  tools: unknown = TOOLS,
) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/connections/slack")) return Promise.resolve(slack) as never;
    if (path.startsWith("/api/settings/tools")) return Promise.resolve(tools) as never;
    return Promise.resolve(state) as never;
  });
}

const PKCE_OK = {
  account: "me@example.com",
  kind: "pkce",
  connected: true,
  team: "leotest",
  // Access token is always ~12h out; that must NOT trigger a warning.
  expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  // Re-consent deadline comfortably beyond the 7-day warning window.
  reconnectBy: Date.now() + 30 * 24 * 60 * 60 * 1000,
  detail: "connected · leotest",
};

const GMAIL_DEAD = {
  sourceErrors: {
    "gmail:direct": {
      message:
        "mailbox=alice@example.com: OAuth refresh failed … HTTP 400; mailbox=bob@example.com: OAuth refresh failed … HTTP 400",
      at: "2026-07-31T12:00:00.000Z",
    },
  },
};

// The row for a connector, found via its name cell.
function row(name: string): HTMLElement {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
});

describe("ConnectionsScreen", () => {
  it("renders one row per connector with a Status column", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    render(<ConnectionsScreen />);

    await screen.findByText("Slack");
    expect(screen.getByRole("columnheader", { name: "Connector" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    await screen.findByText("Jira");
    expect(screen.getAllByRole("row")).toHaveLength(5); // header + 4 connectors
    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByText("Google Calendar")).toBeTruthy();
  });

  // WeChat integration is not on the near roadmap; a permanently grey row is
  // noise on a screen whose job is showing what needs acting on.
  it("does not list WeChat", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    render(<ConnectionsScreen />);
    await screen.findByText("Slack");
    expect(screen.queryByText("WeChat")).toBeNull();
  });

  // Reference data, not an interaction unit — DESIGN.md forbids the card wall
  // this screen used to be.
  it("uses a real table, not cards", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    const { container } = render(<ConnectionsScreen />);
    await screen.findByText("Slack");
    expect(container.querySelector("table")).toBeTruthy();
  });

  it("shows the connected account and workspace on the Slack row", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    render(<ConnectionsScreen />);
    await screen.findByText("me@example.com · leotest");
    expect(within(row("Slack")).getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it("offers Connect, not Reconnect, when nothing is stored", async () => {
    stubApi({ sourceErrors: {} }, { kind: "none", connected: false, expiresAt: 0, reconnectBy: 0 });
    render(<ConnectionsScreen />);
    await screen.findByRole("button", { name: "Connect" });
    expect(within(row("Slack")).getByText("not connected")).toBeTruthy();
  });

  // A degraded /api/connections/slack must not paint the row as connected.
  it("treats an unrecognised Slack payload as not connected", async () => {
    stubApi({ sourceErrors: {} }, { nonsense: true });
    render(<ConnectionsScreen />);
    await screen.findByRole("button", { name: "Connect" });
  });

  // The 30-day refresh window is the failure mode a closed laptop hits, so the
  // row has to warn while it is still fixable rather than after.
  it("flags the re-consent deadline before it lands", async () => {
    stubApi(
      { sourceErrors: {} },
      { ...PKCE_OK, reconnectBy: Date.now() + 2 * 24 * 60 * 60 * 1000 },
    );
    const { container } = render(<ConnectionsScreen />);
    await screen.findByText("reconnect within 2 days");
    expect(container.querySelectorAll(".bg-error")).toHaveLength(1);
  });

  it("reports an expired sign-in", async () => {
    stubApi({ sourceErrors: {} }, { ...PKCE_OK, reconnectBy: Date.now() - 1000 });
    render(<ConnectionsScreen />);
    await screen.findByText("sign-in expired — reconnect to resume");
  });

  // REGRESSION: the access token is ~12h out by design and refreshes itself.
  // Treating it as a deadline made the row permanently red.
  it("stays green while only the 12h access token is near expiry", async () => {
    stubApi({ sourceErrors: {} }, { ...PKCE_OK, expiresAt: Date.now() + 60 * 1000 });
    const { container } = render(<ConnectionsScreen />);
    await screen.findByText("connected");
    expect(container.querySelectorAll(".bg-error")).toHaveLength(0);
  });

  it("invites migration off a legacy hand-pasted token", async () => {
    stubApi({ sourceErrors: {} }, { account: "me@example.com", kind: "legacy", connected: true, expiresAt: 0, reconnectBy: 0 });
    render(<ConnectionsScreen />);
    await screen.findByText("connected · legacy token");
  });

  it("gives one Reconnect button per failing mailbox on the Gmail row", async () => {
    stubApi(GMAIL_DEAD, PKCE_OK);
    render(<ConnectionsScreen />);

    await screen.findByRole("button", { name: "Reconnect alice@example.com" });
    const gmail = row("Gmail");
    expect(within(gmail).getByRole("button", { name: "Reconnect bob@example.com" })).toBeTruthy();
    expect(within(gmail).getByText("token expired — cursor frozen, nothing lost")).toBeTruthy();
  });

  describe("filters", () => {
    it("Needs attention narrows to the broken connector", async () => {
      stubApi(GMAIL_DEAD, PKCE_OK);
      render(<ConnectionsScreen />);
      await screen.findByText("Slack");

      fireEvent.click(screen.getByRole("tab", { name: "Needs attention" }));
      expect(screen.getByText("Gmail")).toBeTruthy();
      expect(screen.queryByText("Slack")).toBeNull();
      expect(screen.queryByText("WeChat")).toBeNull();
    });

    it("Connected excludes an unauthorized MCP tool", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK, { ...TOOLS, authorized: { jira: false } });
      render(<ConnectionsScreen />);
      await screen.findByText("Jira");

      fireEvent.click(screen.getByRole("tab", { name: "Connected" }));
      expect(screen.queryByText("Jira")).toBeNull();
      expect(screen.getByText("Slack")).toBeTruthy();
    });

    // Empty states teach rather than say "nothing here".
    it("explains an empty Needs attention list instead of rendering a blank table", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK);
      render(<ConnectionsScreen />);
      await screen.findByText("Slack");

      fireEvent.click(screen.getByRole("tab", { name: "Needs attention" }));
      expect(
        screen.getByText("Nothing needs attention. Every connector is reading normally."),
      ).toBeTruthy();
    });
  });

  describe("MCP connectors", () => {
    it("lists Jira from the tool registry with its endpoint host", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK);
      render(<ConnectionsScreen />);
      await screen.findByText("Jira");
      expect(screen.getByText("mcp.atlassian.com")).toBeTruthy();
    });

    it("offers Connect when the tool has no stored token", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK, { ...TOOLS, authorized: { jira: false } });
      render(<ConnectionsScreen />);
      const jira = (await screen.findByText("Jira")).closest("tr") as HTMLElement;
      expect(within(jira).getByRole("button", { name: "Connect" })).toBeTruthy();
      expect(within(jira).getByText("not connected")).toBeTruthy();
    });

    it("survives a tools endpoint that fails, rather than blanking the screen", async () => {
      mockApiGet.mockImplementation((path: string) => {
        if (path.startsWith("/api/settings/tools")) return Promise.reject(new Error("boom")) as never;
        if (path.startsWith("/api/connections/slack")) return Promise.resolve(PKCE_OK) as never;
        return Promise.resolve({ sourceErrors: {} }) as never;
      });
      render(<ConnectionsScreen />);
      await screen.findByText("Slack");
      expect(screen.queryByText("Jira")).toBeNull();
    });
  });

  describe("privacy note", () => {
    it("is collapsed until asked for, and names what is read", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK);
      render(<ConnectionsScreen />);
      const toggle = await screen.findByRole("button", { name: "What access means" });
      expect(screen.queryByText(/your DMs, group DMs/)).toBeNull();

      fireEvent.click(toggle);
      expect(screen.getByText(/your DMs, group DMs/)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Hide details" })).toBeTruthy();
    });

    // The one line a privacy note must not omit: message text does leave the
    // machine, to the user's own AI provider. Claiming otherwise would be false.
    it("discloses that message text reaches the AI provider", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK);
      render(<ConnectionsScreen />);
      fireEvent.click(await screen.findByRole("button", { name: "What access means" }));
      expect(screen.getByText(/AI provider you configured/)).toBeTruthy();
      expect(screen.getByText(/There is no server in this product/)).toBeTruthy();
    });
  });
});
