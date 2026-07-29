import { describe, it, expect } from "vitest";
import { selectProjects, renderProjectContext, renderProjectCatalog, type Project } from "./project.js";

const projects: Project[] = [
  {
    id: "TAIV-1",
    company: "taiv",
    name: "box hw/fw",
    goal: "ship + certify the box",
    current_state: "FCC still failing",
    needs: [
      { need: "FCC pass", status: "gap" },
      { need: "audio", status: "partial" },
      { need: "done thing", status: "covered" },
    ],
    blockers: ["FCC re-test not passed"],
    people: [{ key: "michael-dobosz", name: "Michael Dobosz" }],
  },
  {
    id: "OUS-4",
    company: "oushikesi",
    name: "fundraising",
    goal: "close the round",
    people: [{ key: "wechat-0536385365412", name: "范总" }],
  },
];

describe("selectProjects", () => {
  it("matches by sender being a listed person (strong signal)", () => {
    const m = selectProjects(projects, { senderKey: "michael-dobosz", text: "" });
    expect(m).toHaveLength(1);
    expect(m[0]!.project.id).toBe("TAIV-1");
    expect(m[0]!.why).toBe("sender");
  });

  it("falls back to keyword match on project name / id / teammate name", () => {
    const m = selectProjects(projects, { senderKey: null, text: "any update on TAIV-1 fcc?" });
    expect(m.map((x) => x.project.id)).toContain("TAIV-1");
    expect(m[0]!.why).toBe("keyword");
  });

  it("ranks sender-matches before keyword-matches", () => {
    const m = selectProjects(projects, { senderKey: "wechat-0536385365412", text: "box hw/fw stuff" });
    expect(m[0]!.project.id).toBe("OUS-4"); // sender match first
    expect(m[0]!.why).toBe("sender");
  });

  it("returns [] when nothing matches — no fabricated link", () => {
    expect(selectProjects(projects, { senderKey: "nobody", text: "lunch?" })).toEqual([]);
  });

  it("respects the limit", () => {
    expect(selectProjects(projects, { senderKey: null, text: "taiv-1 ous-4", limit: 1 })).toHaveLength(1);
  });
});

describe("renderProjectCatalog", () => {
  it("lists every project as id (company): name — goal, for meaning-based tagging", () => {
    const cat = renderProjectCatalog(projects);
    expect(cat).toContain("TAIV-1 (taiv): box hw/fw — ship + certify the box");
    expect(cat).toContain("OUS-4 (oushikesi): fundraising — close the round");
    expect(cat.split("\n")).toHaveLength(2); // one line per project
  });
  it("returns empty string for no projects", () => {
    expect(renderProjectCatalog([])).toBe("");
  });
});

describe("renderProjectContext", () => {
  it("renders goal + state + ONLY open needs (omits covered) + blockers", () => {
    const r = renderProjectContext(projects[0]!);
    expect(r).toContain("TAIV-1");
    expect(r).toContain("goal: ship");
    expect(r).toContain("[gap] FCC pass");
    expect(r).toContain("[partial] audio");
    expect(r).not.toContain("done thing"); // covered need omitted
    expect(r).toContain("blockers:");
  });
});
