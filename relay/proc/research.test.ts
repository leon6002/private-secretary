import { describe, it, expect, vi } from "vitest";
import { runResearch, hotelQuery, RESEARCH_SYSTEM } from "./research.js";

describe("hotelQuery", () => {
  it("builds a structured query from fields (not raw message text)", () => {
    const q = hotelQuery({ near: "Hangzhou East Railway Station", date: "Tuesday 2026-06-30" });
    expect(q).toContain("near Hangzhou East Railway Station");
    expect(q).toContain("2026-06-30");
    expect(q).toContain("price and distance");
  });

  it("omits optional clauses when absent", () => {
    const q = hotelQuery({ near: "X" });
    expect(q).not.toContain("For a stay around");
  });
});

describe("runResearch", () => {
  it("calls the research caller with WebSearch only + the research system prompt", async () => {
    const research = vi.fn(async () => "  Option A — RMB 160  ");
    const out = await runResearch("hotels near X", { research });
    expect(out).toBe("Option A — RMB 160"); // trimmed
    expect(research).toHaveBeenCalledWith({
      system: RESEARCH_SYSTEM,
      userText: "hotels near X",
      allowedTools: ["WebSearch"],
    });
  });
});
