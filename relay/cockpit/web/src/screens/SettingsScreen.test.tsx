// @vitest-environment jsdom
// SettingsScreen (S3): tab switching, Keys preview masking, and the Activity
// tab's kind-filter refetch — all against a stubbed /api.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet, apiPost } from "../lib/api";
import SettingsScreen from "./SettingsScreen";

const mockApiGet = vi.mocked(apiGet);
const mockApiPost = vi.mocked(apiPost);

// A plausible /api/settings payload. The full key NEVER appears here — only
// the server-computed last-4 preview — and the tests assert it stays that way.
const FULL_KEY = "sk-ant-abcdef1234";
const SETTINGS = {
  llm: { mode: "cli", draftModel: "opus" },
  keys: {
    anthropic: { configured: true, preview: "…1234" },
    deepseek: { configured: false, preview: null },
  },
};
const ACTIVITY = {
  records: [
    { at: "2026-07-31T12:00:00.000Z", kind: "tick", summary: "gmail: drafted 2 cards" },
    { at: "2026-07-31T12:01:00.000Z", kind: "approve", summary: 'approved reply "lunch?"' },
  ],
};

interface GoogleSetup {
  clientConfigured: boolean;
  mailboxes: Array<{ email: string; authorized: boolean; isCalendar: boolean }>;
}

// Client not yet stored; one authorized mailbox, one not, one calendar-flagged.
const GOOGLE_SETUP: GoogleSetup = {
  clientConfigured: false,
  mailboxes: [
    { email: "me@work.com", authorized: false, isCalendar: true },
    { email: "me@gmail.com", authorized: true, isCalendar: false },
  ],
};

function mockApi(google: GoogleSetup = GOOGLE_SETUP) {
  mockApiGet.mockImplementation((path: string) => {
    // /api/settings/google must match before the /api/settings prefix.
    if (path === "/api/settings/google") return Promise.resolve(google);
    if (path.startsWith("/api/settings")) return Promise.resolve(SETTINGS);
    if (path.startsWith("/api/activity")) return Promise.resolve(ACTIVITY);
    return Promise.reject(new Error(`unexpected apiGet ${path}`));
  });
}

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
  mockApiPost.mockReset();
});

describe("SettingsScreen", () => {
  it("renders the General tab by default and switches tabs", async () => {
    mockApi();
    render(<SettingsScreen />);

    // General is the default: the theme picker is visible, marked tab active.
    expect(await screen.findByText("Theme")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Model" }));
    expect(await screen.findByText("Draft model")).toBeTruthy();
    expect(screen.getByText("CLI (claude -p)")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Keys" }));
    expect(await screen.findByText("Anthropic API key")).toBeTruthy();
    expect(screen.getByText("DeepSeek API key")).toBeTruthy();
  });

  it("Keys tab shows the last-4 preview, never the full key", async () => {
    mockApi();
    const { container } = render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Keys" }));

    expect(await screen.findByText("configured · …1234")).toBeTruthy();
    expect(screen.getByText("not configured")).toBeTruthy(); // deepseek row
    expect(container.textContent).not.toContain(FULL_KEY);
  });

  it("Activity tab renders log rows and refetches with ?kind= when a chip is clicked", async () => {
    mockApi();
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByText("gmail: drafted 2 cards")).toBeTruthy();
    expect(screen.getByText('approved reply "lunch?"')).toBeTruthy();
    expect(mockApiGet).toHaveBeenCalledWith("/api/activity?tail=200");

    fireEvent.click(screen.getByRole("button", { name: "error" }));
    await waitFor(() =>
      expect(mockApiGet).toHaveBeenCalledWith("/api/activity?tail=200&kind=error"),
    );
  });

  it("Google tab renders the status overview from /api/settings/google", async () => {
    mockApi();
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Google" }));

    // Overview: client not configured, per-mailbox authorized states, calendar tag.
    expect(await screen.findByText("OAuth client")).toBeTruthy();
    expect(screen.getByText("not configured")).toBeTruthy();
    // Each mailbox renders in both the overview and step 5.
    expect(screen.getAllByText("me@work.com").length).toBeGreaterThan(0);
    expect(screen.getByText("calendar")).toBeTruthy();
    // "authorized" appears in both the overview row and step 5 for me@gmail.com.
    expect(screen.getAllByText("authorized").length).toBeGreaterThan(0);
    expect(mockApiGet).toHaveBeenCalledWith("/api/settings/google");
  });

  it("Google tab step 4 saves the pasted client JSON to the Keychain endpoint", async () => {
    mockApiPost.mockResolvedValue({ ok: true });
    mockApi(); // clientConfigured: false
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Google" }));

    // Step 4 is visible with the paste area while the client is unconfigured.
    const box = await screen.findByLabelText("OAuth client JSON");
    const json = JSON.stringify({ installed: { client_id: "x.apps.googleusercontent.com" } });
    fireEvent.change(box, { target: { value: json } });
    fireEvent.click(screen.getByRole("button", { name: "Save to macOS Keychain" }));

    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/settings/google/client", { json }),
    );
  });

  it("Google tab authorizes an unauthorized mailbox and re-authorizes an authorized one", async () => {
    mockApiPost.mockResolvedValue({ started: true });
    mockApi({ ...GOOGLE_SETUP, clientConfigured: true });
    render(<SettingsScreen />);
    fireEvent.click(screen.getByRole("tab", { name: "Google" }));

    fireEvent.click(await screen.findByRole("button", { name: "Authorize me@work.com" }));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/settings/google/authorize", {
        mailbox: "me@work.com",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-authorize" }));
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith("/api/settings/google/authorize", {
        mailbox: "me@gmail.com",
      }),
    );
  });
});
