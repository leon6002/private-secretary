// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import ConnectorIcon, { type ConnectorId } from "./ConnectorIcon";

const IDS: ConnectorId[] = ["slack", "gmail", "calendar", "wechat"];

afterEach(cleanup);

describe("ConnectorIcon", () => {
  // A mistyped id would render nothing at all — silently, since the row's text
  // still shows. Assert every id actually produces geometry.
  it.each(IDS)("renders drawn geometry for %s", (id) => {
    const { container } = render(<ConnectorIcon id={id} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    paths.forEach((p) => expect(p.getAttribute("d")?.length ?? 0).toBeGreaterThan(20));
  });

  // Inline only: the cockpit serves these from a local process, so a remote
  // reference would be a logo that silently fails to load.
  it.each(IDS)("references no remote asset for %s", (id) => {
    const { container } = render(<ConnectorIcon id={id} />);
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
    expect(container.querySelector("image")).toBeNull();
  });

  // The connector name sits right next to it; a second label would be noise
  // for a screen reader.
  it.each(IDS)("is decorative for assistive tech (%s)", (id) => {
    const { container } = render(<ConnectorIcon id={id} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
