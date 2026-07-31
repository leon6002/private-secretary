// @vitest-environment jsdom
// SettingsScreen (S3): tab switching, Keys preview masking, and the Activity
// tab's kind-filter refetch — all against a stubbed /api.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../lib/api", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from "../lib/api";
import SettingsScreen from "./SettingsScreen";

const mockApiGet = vi.mocked(apiGet);

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

function mockApi() {
  mockApiGet.mockImplementation((path: string) => {
    if (path.startsWith("/api/settings")) return Promise.resolve(SETTINGS);
    if (path.startsWith("/api/activity")) return Promise.resolve(ACTIVITY);
    return Promise.reject(new Error(`unexpected apiGet ${path}`));
  });
}

afterEach(() => {
  cleanup();
  mockApiGet.mockReset();
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
});
