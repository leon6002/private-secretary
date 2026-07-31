// Human viewer for the activity log (F3) — "what did the engine actually do?"
// without opening loop-state.json. Zero LLM, read-only.
//
//   npx tsx scripts/show-activity.ts                     # last 50 events
//   npx tsx scripts/show-activity.ts --tail 100          # last 100
//   npx tsx scripts/show-activity.ts --kind supersede    # one kind only
//   npx tsx scripts/show-activity.ts --state state/loop-state.json

import { existsSync, readFileSync } from "node:fs";
import { activityPathFor, readActivity } from "../relay/io/activity-log.js";

const argv = process.argv.slice(2);
const arg = (flag: string, dflt: string): string =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1]! : dflt;

const statePath = arg("--state", "state/loop-state.json");
const tail = Number(arg("--tail", "50"));
const kind = argv.includes("--kind") ? arg("--kind", "") : undefined;

const path = activityPathFor(statePath);
if (!existsSync(path)) {
  console.error(`no activity log at ${path} — the daemon/cockpit writes it as events happen`);
  process.exit(1);
}

let recs = readActivity(readFileSync(path, "utf8"));
if (kind) recs = recs.filter((r) => r.kind === kind);
recs = recs.slice(-tail);

if (recs.length === 0) {
  console.log(kind ? `no "${kind}" events in ${path}` : `no events in ${path}`);
  process.exit(0);
}

// One line per event: local time | kind | summary. Kind is padded so the
// summaries align; the full ISO stays available in the JSONL itself.
for (const r of recs) {
  const at = new Date(r.at);
  const stamp = Number.isNaN(at.getTime()) ? r.at : at.toLocaleString();
  console.log(`${stamp} | ${r.kind.padEnd(12)} | ${r.summary}`);
}
