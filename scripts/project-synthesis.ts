#!/usr/bin/env -S npx tsx
// P7 — print a project-level briefing (state → gaps → next actions) for every
// active project that has open cards. Reads the project RAG + the open queue +
// Leo's decision profile, runs one LLM pass per project via `claude -p`.
//
//   npx tsx scripts/project-synthesis.ts [--state p] [--projects dir] [--all] [--json]
//     --all   include projects with no open cards too
//     --json  emit raw JSON instead of the formatted report

import { resolve } from "node:path";
import { loadState } from "../relay/io/state.js";
import { loadProjects, loadLeoProfile } from "../relay/io/projects.js";
import { createClaudeCliJsonCaller } from "../relay/proc/llm-claude-cli.js";
import { synthesizeProjects } from "../relay/proc/project-synthesis.js";

function str(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const statePath = resolve(str("--state", resolve(process.cwd(), "state/loop-state.json")));
const projectsDir = resolve(str("--projects", resolve(process.cwd(), "projects/_staged")));
const includeEmpty = process.argv.includes("--all");
const asJson = process.argv.includes("--json");

async function main(): Promise<void> {
  const projects = loadProjects(projectsDir);
  const state = loadState(statePath);
  // Open cards = what's live and worth synthesizing around.
  const open = state.actions.filter((a) => a.status === "suggested" || a.status === "approved");
  const decisionProfile = loadLeoProfile(resolve(process.cwd(), "projects/LEO-DECISION-PROFILE.md"));
  const facts = loadLeoProfile(resolve(process.cwd(), "projects/LEO-FACTS.md")).trim();
  const leoProfile = facts ? `${decisionProfile}\n\n## LEO'S OWN FACTS:\n${facts}` : decisionProfile;

  console.error(`[synthesis] ${projects.length} projects, ${open.length} open cards; running...`);
  const json = createClaudeCliJsonCaller({ model: "opus" });
  const { briefings, errors } = await synthesizeProjects(projects, open, {
    json,
    leoProfile: leoProfile.trim() || undefined,
    includeEmpty,
  });

  if (asJson) {
    console.log(JSON.stringify({ briefings, errors }, null, 2));
    return;
  }
  for (const b of briefings) {
    const p = projects.find((x) => x.id === b.projectId);
    console.log(`\n━━━ ${b.projectId}${p?.name ? ` — ${p.name}` : ""} ━━━`);
    console.log(`STATE: ${b.state}`);
    if (b.gaps.length) {
      console.log(`GAPS:`);
      for (const g of b.gaps) console.log(`  • ${g}`);
    }
    if (b.next_actions.length) {
      console.log(`NEXT:`);
      for (const n of b.next_actions) console.log(`  → ${n.action}${n.who ? `  [${n.who}]` : ""}\n     why: ${n.why}`);
    }
  }
  if (errors.length) console.error(`\n[synthesis] ${errors.length} project(s) errored:`, JSON.stringify(errors));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
