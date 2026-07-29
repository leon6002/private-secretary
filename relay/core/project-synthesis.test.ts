import { describe, it, expect } from "vitest";
import {
  groupCardsByProject,
  buildSynthesisRequest,
  SYNTHESIS_TOOL_NAME,
} from "./project-synthesis.js";
import type { Project } from "./project.js";
import type { ActionItem } from "./action-item.js";

const projects: Project[] = [
  {
    id: "OSYX-1",
    name: "Bao proliferation",
    company: "osyx",
    goal: "Get Bao Hypervisor adopted",
    needs: [{ need: "intro deck", status: "gap" }],
    people: [{ key: "wechat-amon", name: "Amon" }],
  },
  {
    id: "OUS-2",
    name: "Hangzhou customer visit",
    company: "oushikesi",
    people: [{ key: "wechat-chen", name: "陈古龙" }],
  },
];

function card(over: Partial<ActionItem>): ActionItem {
  return {
    id: "x",
    source_message_id: "wechat:x:1",
    action_type: "reply",
    target: {},
    reason: "r",
    confidence: 0.5,
    params: {},
    status: "suggested",
    created_at: "2026-06-28T00:00:00Z",
    ...over,
  };
}

describe("groupCardsByProject", () => {
  it("assigns a card to the project whose person is its recipient (strong match)", () => {
    const cards = [card({ id: "a", target: { personaKey: "wechat-amon" } })];
    const g = groupCardsByProject(projects, cards);
    expect(g.get("OSYX-1")?.map((c) => c.id)).toEqual(["a"]);
    expect(g.has("OUS-2")).toBe(false);
  });

  it("falls back to keyword match on card text when no person matches", () => {
    const cards = [card({ id: "b", headline: "陈古龙 wants a hotel" })];
    const g = groupCardsByProject(projects, cards);
    expect(g.get("OUS-2")?.map((c) => c.id)).toEqual(["b"]);
  });

  it("drops a card that matches no project (no fabricated link)", () => {
    const cards = [card({ id: "c", target: { personaKey: "stranger" }, headline: "totally unrelated" })];
    const g = groupCardsByProject(projects, cards);
    expect(g.size).toBe(0);
  });
});

describe("buildSynthesisRequest", () => {
  it("renders the project + cards and forces the briefing tool", () => {
    const req = buildSynthesisRequest({
      project: projects[0]!,
      cards: [card({ headline: "Amon asks for materials", context: { sender_handle: "Amon" } })],
    });
    expect(req.toolName).toBe(SYNTHESIS_TOOL_NAME);
    expect(req.userText).toContain("OSYX-1");
    expect(req.userText).toContain("Amon asks for materials");
    expect(req.system).toContain("project strategist");
  });

  it("injects the Leo decision profile when provided", () => {
    const req = buildSynthesisRequest({
      project: projects[0]!,
      cards: [],
      leoProfile: "ALWAYS route by capability.",
    });
    expect(req.system).toContain("HOW LEO DECIDES");
    expect(req.system).toContain("route by capability");
    expect(req.userText).toContain("no open cards");
  });
});
