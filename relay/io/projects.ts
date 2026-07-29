// Load the project RAG + the Leo decision profile from disk (both gitignored,
// local-only). fs only — the pure matching/rendering lives in core/project.ts.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Project } from "../core/project.js";

// Read every *.yaml in a project dir into Project[]. Skips non-project helper
// files (OPEN-QUESTIONS.md etc are .md so naturally excluded). Tolerant: a file
// that fails to parse is skipped, not fatal.
export function loadProjects(dir: string): Project[] {
  if (!existsSync(dir)) return [];
  const out: Project[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const p = parse(readFileSync(join(dir, f), "utf8")) as Project;
      if (p && typeof p.id === "string") out.push(p);
    } catch {
      /* skip unparseable */
    }
  }
  return out;
}

// The Leo decision profile (LEO-DECISION-PROFILE.md) as raw markdown, to prepend
// to the drafter's system prompt so it decides AS Leo. Returns "" if absent.
export function loadLeoProfile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}
