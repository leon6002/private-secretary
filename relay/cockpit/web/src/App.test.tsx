// @vitest-environment jsdom
// Smoke test for the S1 shell: the rail renders all five destinations. Screen
// content is still placeholders (per-screen tests arrive with S2–S5).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "./App";

afterEach(cleanup);

describe("App shell", () => {
  it("renders the five rail navigation items", () => {
    render(<App />);
    for (const label of ["Queue", "Projects", "People", "Connections", "Settings"]) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
  });

  it("marks the Queue route active and reserves its pending-badge slot", () => {
    render(<App />);
    // HashRouter defaults to "/", the Queue route.
    const queue = screen.getByRole("link", { name: "Queue" });
    expect(queue.className).toContain("text-primary");
    expect(screen.getByTestId("pending-badge")).toBeTruthy();
  });
});
