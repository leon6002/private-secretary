// Freeze the shadow-log into an immutable replay corpus (P0 task 4).
//
// The live shadow-log keeps growing; an eval corpus must not. This copies it
// once, records the round count + freeze date, and marks the copy read-only so a
// later run can't silently drift.
//
//   npx tsx scripts/freeze-corpus.ts [--state state/loop-state.json] [--out eval/replay-corpus]

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseCorpus, replayStats, survival } from "../relay/eval/replay.js";
import { labelsPathFor, readLabels } from "../relay/io/labels.js";
import { loadState } from "../relay/io/state.js";

const argv = process.argv.slice(2);
const arg = (flag: string, dflt: string): string =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1]! : dflt;

const statePath = arg("--state", "state/loop-state.json");
const outDir = arg("--out", "eval/replay-corpus");
const shadowPath = join(dirname(statePath), "shadow-log.jsonl");

if (!existsSync(shadowPath)) {
  console.error(`no shadow log at ${shadowPath}`);
  process.exit(1);
}

const frozenAt = new Date().toISOString();
const text = readFileSync(shadowPath, "utf8");
const corpus = parseCorpus(text, frozenAt);
const stats = replayStats(corpus);

mkdirSync(outDir, { recursive: true });
const corpusFile = join(outDir, "shadow-log.jsonl");
copyFileSync(shadowPath, corpusFile);
chmodSync(corpusFile, 0o444); // read-only: a corpus that drifts is not a corpus

const live = loadState(statePath).actions.map((a) => a.id);
const labelsPath = labelsPathFor(statePath);
const ledger = existsSync(labelsPath)
  ? readLabels(readFileSync(labelsPath, "utf8")).map((r) => r.action_id)
  : [];
const surv = survival(stats, live, ledger);

writeFileSync(
  join(outDir, "MANIFEST.json"),
  JSON.stringify({ frozen_at: frozenAt, source: shadowPath, ...stats, action_ids: undefined, survival: surv }, null, 2) + "\n",
  "utf8",
);

console.log(`corpus frozen → ${corpusFile} (read-only)`);
console.log(`  rounds:                ${stats.rounds}`);
console.log(`  source messages:       ${stats.source_messages}`);
console.log(`  filtered:              ${stats.filtered}  (with text: ${stats.filtered_with_text})`);
console.log(`  action snapshots:      ${stats.actions_seen}  (distinct ids: ${stats.distinct_action_ids})`);
console.log("");
console.log("  record survival (the label leak, measured):");
console.log(`    seen in shadow log:  ${surv.seen}`);
console.log(`    still in live state: ${surv.in_live_state}`);
console.log(`    in label ledger:     ${surv.in_label_ledger}`);
console.log(`    UNRECOVERABLE:       ${surv.lost}   → survival ${(surv.survival_rate * 100).toFixed(1)}%`);
console.log("");
console.log("  filter reasons:");
for (const [r, n] of Object.entries(stats.filter_reasons)) console.log(`    ${r.padEnd(28)} ${n}`);
