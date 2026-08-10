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

import { apiGet, apiPost } from "../lib/api";
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
  slack: unknown = { workspaces: [ws({ active: "none", oauth: NONE })] },
  tools: unknown = TOOLS,
) {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/identity"))
      return Promise.resolve({ configured: true, primaryEmail: "me@example.com" }) as never;
    if (path.startsWith("/api/connections/slack")) return Promise.resolve(slack) as never;
    if (path.startsWith("/api/settings/tools")) return Promise.resolve(tools) as never;
    return Promise.resolve(state) as never;
  });
}

const NONE = { present: false, expiresAt: 0, reconnectBy: 0 };
const OAUTH_CRED = {
  present: true,
  team: "leotest",
  // Access token is always ~12h out; that must NOT trigger a warning.
  expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  // Re-consent deadline comfortably beyond the 7-day warning window.
  reconnectBy: Date.now() + 30 * 24 * 60 * 60 * 1000,
};
// Ours connected, no legacy token — the state after a plain one-click connect.
function ws(over: Record<string, unknown> = {}) {
  return {
    account: "me@example.com",
    label: "slack:leotest",
    active: "oauth",
    legacy: NONE,
    oauth: OAUTH_CRED,
    ...over,
  };
}
// Ours connected, no own-app token — the state after a plain one-click connect.
const PKCE_OK = { workspaces: [ws()] };

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

    await screen.findByText("Slack · leotest");
    expect(screen.getByRole("columnheader", { name: "Connector" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    await screen.findByText("Jira");
    expect(screen.getAllByRole("row")).toHaveLength(6); // header + 5 rows (Slack x2)
    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByText("Google Calendar")).toBeTruthy();
  });

  // WeChat integration is not on the near roadmap; a permanently grey row is
  // noise on a screen whose job is showing what needs acting on.
  it("does not list WeChat", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    render(<ConnectionsScreen />);
    await screen.findByText("Slack · leotest");
    expect(screen.queryByText("WeChat")).toBeNull();
  });

  // Reference data, not an interaction unit — DESIGN.md forbids the card wall
  // this screen used to be.
  it("uses a real table, not cards", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    const { container } = render(<ConnectionsScreen />);
    await screen.findByText("Slack · leotest");
    expect(container.querySelector("table")).toBeTruthy();
  });

  // The workspace is the USER's own, chosen on Slack's consent screen — worth
  // naming, and not to be confused with the workspace our app is registered in.
  it("names the user's own workspace on the row", async () => {
    stubApi({ sourceErrors: {} }, PKCE_OK);
    render(<ConnectionsScreen />);
    const ours = (await screen.findByText("Slack · leotest")).closest("tr") as HTMLElement;
    expect(within(ours).getByText("me@example.com")).toBeTruthy();
    expect(within(ours).getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });

  // The multi-account fix: a machine that reads Taiv AND OSYX must show BOTH
  // workspaces as their own rows, not just the default one. Preserved from
  // 27bb03b; the workspace now names the row and the account is its subtitle,
  // and each workspace carries its own pair of credential rows.
  it("renders a row per configured Slack workspace, each naming its account", async () => {
    stubApi({ sourceErrors: {} }, {
      workspaces: [
        ws({ account: "leo@taiv.tv", label: "slack:direct", oauth: { ...OAUTH_CRED, team: "Taiv" } }),
        ws({ account: "huizhezheng@gmail.com", label: "slack:osyx", oauth: { ...OAUTH_CRED, team: "OSYX" } }),
      ],
    });
    render(<ConnectionsScreen />);

    const taiv = (await screen.findByText("Slack · Taiv")).closest("tr") as HTMLElement;
    expect(within(taiv).getByText("leo@taiv.tv")).toBeTruthy();
    const osyx = (await screen.findByText("Slack · OSYX")).closest("tr") as HTMLElement;
    expect(within(osyx).getByText("huizhezheng@gmail.com")).toBeTruthy();
  });

  // Also from 27bb03b: one workspace failing must not paint the others red.
  it("keys each workspace's error to its own source label", async () => {
    stubApi(
      { sourceErrors: { "slack:osyx": { message: "boom", at: "2026-08-09T00:00:00Z" } } },
      {
        workspaces: [
          ws({ account: "leo@taiv.tv", label: "slack:direct", oauth: { ...OAUTH_CRED, team: "Taiv" } }),
          ws({ account: "huizhezheng@gmail.com", label: "slack:osyx", oauth: { ...OAUTH_CRED, team: "OSYX" } }),
        ],
      },
    );
    render(<ConnectionsScreen />);

    const osyx = (await screen.findByText("Slack · OSYX")).closest("tr") as HTMLElement;
    expect(within(osyx).getByText(/token issue/)).toBeTruthy();
    const taiv = (await screen.findByText("Slack · Taiv")).closest("tr") as HTMLElement;
    expect(within(taiv).queryByText(/token issue/)).toBeNull();
  });

  it("offers Connect, not Reconnect, when nothing is stored", async () => {
    stubApi({ sourceErrors: {} }, { workspaces: [ws({ active: "none", oauth: NONE })] });
    render(<ConnectionsScreen />);
    await screen.findByRole("button", { name: "Connect" });
    expect(within(row("Slack · leotest")).getByText("not connected")).toBeTruthy();
  });

  // A degraded /api/connections/slack must not blank the screen. Showing no
  // Slack rows is the safe reading — better than inventing a connected one.
  it("renders the rest of the table when the Slack payload is unrecognised", async () => {
    stubApi({ sourceErrors: {} }, { nonsense: true });
    render(<ConnectionsScreen />);
    await screen.findByText("Gmail");
    expect(screen.queryByText(/^Slack · /)).toBeNull();
  });

  // The 30-day refresh window is the failure mode a closed laptop hits, so the
  // row has to warn while it is still fixable rather than after.
  it("flags the re-consent deadline before it lands", async () => {
    stubApi(
      { sourceErrors: {} },
      { workspaces: [ws({ oauth: { ...OAUTH_CRED, reconnectBy: Date.now() + 2 * 24 * 60 * 60 * 1000 } })] },
    );
    const { container } = render(<ConnectionsScreen />);
    await screen.findByText("reconnect within 2 days");
    expect(container.querySelectorAll(".bg-error")).toHaveLength(1);
  });

  it("reports an expired sign-in", async () => {
    stubApi({ sourceErrors: {} }, { workspaces: [ws({ oauth: { ...OAUTH_CRED, reconnectBy: Date.now() - 1000 } })] });
    render(<ConnectionsScreen />);
    await screen.findByText("sign-in expired — reconnect to resume");
  });

  // REGRESSION: the access token is ~12h out by design and refreshes itself.
  // Treating it as a deadline made the row permanently red.
  it("stays green while only the 12h access token is near expiry", async () => {
    stubApi({ sourceErrors: {} }, { workspaces: [ws({ oauth: { ...OAUTH_CRED, expiresAt: Date.now() + 60 * 1000 } })] });
    const { container } = render(<ConnectionsScreen />);
    await screen.findByText("connected");
    expect(container.querySelectorAll(".bg-error")).toHaveLength(0);
  });

  it("invites migration off a legacy hand-pasted token", async () => {
    stubApi({ sourceErrors: {} }, {
      workspaces: [ws({ active: "legacy", legacy: { present: true, expiresAt: 0, reconnectBy: 0 }, oauth: NONE })],
    });
    render(<ConnectionsScreen />);
    const legacy = (await screen.findByText("Slack · leotest · your own app")).closest("tr") as HTMLElement;
    expect(within(legacy).getByText("connected · in use")).toBeTruthy();
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
      await screen.findByText("Slack · leotest");

      fireEvent.click(screen.getByRole("tab", { name: "Needs attention" }));
      expect(screen.getByText("Gmail")).toBeTruthy();
      expect(screen.queryByText("Slack · leotest")).toBeNull();
      expect(screen.queryByText("WeChat")).toBeNull();
    });

    it("Connected excludes an unauthorized MCP tool", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK, { ...TOOLS, authorized: { jira: false } });
      render(<ConnectionsScreen />);
      await screen.findByText("Jira");

      fireEvent.click(screen.getByRole("tab", { name: "Connected" }));
      expect(screen.queryByText("Jira")).toBeNull();
      expect(screen.getByText("Slack · leotest")).toBeTruthy();
    });

    // Empty states teach rather than say "nothing here".
    it("explains an empty Needs attention list instead of rendering a blank table", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK);
      render(<ConnectionsScreen />);
      await screen.findByText("Slack · leotest");

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
        if (path.startsWith("/api/identity"))
          return Promise.resolve({ configured: true, primaryEmail: "me@example.com" }) as never;
        if (path.startsWith("/api/settings/tools")) return Promise.reject(new Error("boom")) as never;
        if (path.startsWith("/api/connections/slack")) return Promise.resolve(PKCE_OK) as never;
        return Promise.resolve({ sourceErrors: {} }) as never;
      });
      render(<ConnectionsScreen />);
      await screen.findByText("Slack · leotest");
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

  // Disconnect must be one click and reversible: after it, the row offers
  // Connect again rather than stranding the user with no way back.
  describe("disconnect", () => {
    it("revokes Slack and returns the row to Connect", async () => {
      const mockApiPost = vi.mocked(apiPost);
      let connected = true;
      mockApiGet.mockImplementation((path: string) => {
        if (path.startsWith("/api/identity"))
          return Promise.resolve({ configured: true, primaryEmail: "me@example.com" }) as never;
        if (path.startsWith("/api/connections/slack"))
          return Promise.resolve(
            connected ? PKCE_OK : { workspaces: [ws({ active: "none", oauth: NONE })] },
          ) as never;
        if (path.startsWith("/api/settings/tools")) return Promise.resolve(TOOLS) as never;
        return Promise.resolve({ sourceErrors: {} }) as never;
      });
      mockApiPost.mockImplementation((path: string) => {
        if (path.includes("/disconnect")) connected = false;
        return Promise.resolve({ detail: "Disconnected." }) as never;
      });

      render(<ConnectionsScreen />);
      // Scoped to our Slack row: Jira and the own-app row have their own.
      const slack = (await screen.findByText("Slack · leotest")).closest("tr") as HTMLElement;
      fireEvent.click(within(slack).getByRole("button", { name: "Disconnect" }));

      await screen.findByRole("button", { name: "Connect" });
      // Names which credential: the default must never be the unrecoverable one.
      expect(mockApiPost).toHaveBeenCalledWith("/api/connections/slack/disconnect", {
        which: "oauth",
        account: "me@example.com",
      });
      mockApiPost.mockReset();
    });

    it("posts deauthorize for an MCP tool", async () => {
      const mockApiPost = vi.mocked(apiPost);
      mockApiPost.mockResolvedValue({} as never);
      stubApi({ sourceErrors: {} }, { workspaces: [ws({ active: "none", oauth: NONE })] });
      render(<ConnectionsScreen />);

      const jira = (await screen.findByText("Jira")).closest("tr") as HTMLElement;
      fireEvent.click(within(jira).getByRole("button", { name: "Disconnect" }));
      expect(mockApiPost).toHaveBeenCalledWith("/api/settings/tools/jira/deauthorize", {});
      mockApiPost.mockReset();
    });
  });

  // A fresh install has no config/identity.json, and without it nothing polls
  // and Connect is inert. The screen must ask rather than show a dead table.
  describe("first run", () => {
    function stubUnconfigured() {
      mockApiGet.mockImplementation((path: string) => {
        if (path.startsWith("/api/identity"))
          return Promise.resolve({ configured: false, primaryEmail: "" }) as never;
        if (path.startsWith("/api/connections/slack"))
          return Promise.resolve({ workspaces: [ws({ active: "none", oauth: NONE })] }) as never;
        if (path.startsWith("/api/settings/tools")) return Promise.resolve(TOOLS) as never;
        return Promise.resolve({ sourceErrors: {} }) as never;
      });
    }

    it("asks who the instance is for instead of showing the table", async () => {
      stubUnconfigured();
      render(<ConnectionsScreen />);

      await screen.findByLabelText("Your work email");
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    });

    it("saves the email and re-reads status", async () => {
      const mockApiPost = vi.mocked(apiPost);
      mockApiPost.mockResolvedValue({ daemonRestarted: true } as never);
      stubUnconfigured();
      render(<ConnectionsScreen />);

      const input = await screen.findByLabelText("Your work email");
      fireEvent.change(input, { target: { value: "me@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await vi.waitFor(() =>
        expect(mockApiPost).toHaveBeenCalledWith("/api/identity", { primaryEmail: "me@example.com" }),
      );
      mockApiPost.mockReset();
    });

    // A failing status read must not offer to overwrite a working config.
    it("does not show the form when the identity read fails", async () => {
      mockApiGet.mockImplementation((path: string) => {
        if (path.startsWith("/api/identity")) return Promise.reject(new Error("down")) as never;
        if (path.startsWith("/api/connections/slack")) return Promise.resolve(PKCE_OK) as never;
        if (path.startsWith("/api/settings/tools")) return Promise.resolve(TOOLS) as never;
        return Promise.resolve({ sourceErrors: {} }) as never;
      });
      render(<ConnectionsScreen />);

      await screen.findByText("Slack · leotest");
      expect(screen.queryByLabelText("Your work email")).toBeNull();
    });
  });

  // Both credentials must be visible and independent: ours is rate-limited
  // until the Slack app is on the Marketplace, so the user's own app token
  // stays the only workable path for a heavy mailbox.
  describe("legacy credential alongside the one-click one", () => {
    const BOTH = {
      workspaces: [ws({ active: "legacy", legacy: { present: true, expiresAt: 0, reconnectBy: 0 } })],
    };

    it("shows both rows and marks which one is actually in use", async () => {
      stubApi({ sourceErrors: {} }, BOTH);
      render(<ConnectionsScreen />);

      const legacy = (await screen.findByText("Slack · leotest · your own app")).closest("tr") as HTMLElement;
      expect(within(legacy).getByText("connected · in use")).toBeTruthy();
      const ours = row("Slack · leotest");
      expect(within(ours).getByText("connected · standby")).toBeTruthy();
    });

    // One stray click would cost the only unthrottled credential, and our flow
    // cannot reissue it — it only ever mints our own app's token.
    it("disables Disconnect on the legacy row", async () => {
      stubApi({ sourceErrors: {} }, BOTH);
      render(<ConnectionsScreen />);

      const legacy = (await screen.findByText("Slack · leotest · your own app")).closest("tr") as HTMLElement;
      const btn = within(legacy).getByRole("button", { name: "Disconnect" }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      expect(btn.title).toMatch(/cannot be restored/i);
    });

    it("still allows disconnecting our own credential, and names which one", async () => {
      const mockApiPost = vi.mocked(apiPost);
      mockApiPost.mockResolvedValue({ detail: "Disconnected." } as never);
      stubApi({ sourceErrors: {} }, BOTH);
      render(<ConnectionsScreen />);

      const ours = (await screen.findByText("Slack · leotest")).closest("tr") as HTMLElement;
      fireEvent.click(within(ours).getByRole("button", { name: "Disconnect" }));
      expect(mockApiPost).toHaveBeenCalledWith("/api/connections/slack/disconnect", {
        which: "oauth",
        account: "me@example.com",
      });
      mockApiPost.mockReset();
    });

    it("offers a paste field when no legacy token is stored", async () => {
      stubApi({ sourceErrors: {} }, PKCE_OK);
      render(<ConnectionsScreen />);
      await screen.findByLabelText("User token from your own Slack app");
    });
  });
});
