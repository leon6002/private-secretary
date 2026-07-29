// P7 — runs the project-level synthesis (core/project-synthesis.ts) over a set of
// projects + open cards via an injected JSON LLM caller. One LLM pass per project
// (sequential, bounded). I/O-free apart from the injected caller, so it's testable
// with a stub. The CLI/daemon supplies the caller + loads projects/cards/leoProfile.

import type { Project } from "../core/project.js";
import type { ActionItem } from "../core/action-item.js";
import {
  groupCardsByProject,
  buildSynthesisRequest,
  type ProjectBriefing,
} from "../core/project-synthesis.js";
import type { JsonLlmCaller } from "./llm-claude-cli.js";

export interface SynthesisDeps {
  json: JsonLlmCaller;
  leoProfile?: string;
  // Synthesize every project, or only those with ≥1 open card (default: only
  // projects with open cards — those are the live ones worth a briefing).
  includeEmpty?: boolean;
}

export interface SynthesisResult {
  briefings: ProjectBriefing[];
  errors: Array<{ projectId: string; error: string }>;
}

// Produce a briefing per project (state → gaps → next actions). Projects with no
// open card are skipped unless includeEmpty. A project whose LLM call throws or
// returns a malformed object is isolated (recorded in errors), never fatal.
export async function synthesizeProjects(
  projects: Project[],
  cards: ActionItem[],
  deps: SynthesisDeps,
): Promise<SynthesisResult> {
  const grouped = groupCardsByProject(projects, cards);
  const targets = projects.filter((p) => deps.includeEmpty || grouped.has(p.id));
  const briefings: ProjectBriefing[] = [];
  const errors: SynthesisResult["errors"] = [];
  for (const project of targets) {
    const related = grouped.get(project.id) ?? [];
    const req = buildSynthesisRequest({ project, cards: related, leoProfile: deps.leoProfile });
    try {
      const res = (await deps.json({
        system: req.system,
        userText: req.userText,
        toolInputSchema: req.toolInputSchema,
      })) as Partial<ProjectBriefing> | null;
      if (res && typeof res.state === "string") {
        briefings.push({
          projectId: project.id,
          state: res.state,
          gaps: Array.isArray(res.gaps) ? res.gaps : [],
          next_actions: Array.isArray(res.next_actions) ? res.next_actions : [],
        });
      } else {
        errors.push({ projectId: project.id, error: "malformed briefing (no state)" });
      }
    } catch (e) {
      errors.push({ projectId: project.id, error: (e as Error).message ?? String(e) });
    }
  }
  return { briefings, errors };
}
