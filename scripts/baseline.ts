// Freeze an accuracy baseline from the label ledger (P0 task 3). Zero LLM.
//
//   npx tsx scripts/baseline.ts [--state state/loop-state.json] [--out eval] [--stdout]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { labelsPathFor, readLabels } from "../relay/io/labels.js";
import { buildBaseline, renderBaselineMarkdown } from "../relay/eval/baseline.js";

const argv = process.argv.slice(2);
const arg = (flag: string, dflt: string): string =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1]! : dflt;

const statePath = arg("--state", "state/loop-state.json");
const outDir = arg("--out", "eval");
const labelsPath = labelsPathFor(statePath);

if (!existsSync(labelsPath)) {
  console.error(`no label ledger at ${labelsPath} — run scripts/export-labels.ts first`);
  process.exit(1);
}

const labels = readLabels(readFileSync(labelsPath, "utf8"));
// Date is stamped from the clock, then held fixed so the JSON and the Markdown
// describe the same run.
const generatedAt = new Date().toISOString();
const report = buildBaseline(labels, generatedAt);
const md = renderBaselineMarkdown(report);

if (argv.includes("--stdout")) {
  console.log(md);
} else {
  mkdirSync(outDir, { recursive: true });
  const day = generatedAt.slice(0, 10);
  const jsonPath = join(outDir, `baseline-${day}.json`);
  const mdPath = join(outDir, `baseline-${day}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(mdPath, md + "\n", "utf8");
  console.log(`baseline frozen:\n  ${jsonPath}\n  ${mdPath}`);
}

// Always echo the headline table so a run is self-documenting.
console.log("");
console.log("  type      executed  rejected  deferred  decided  precision");
for (const s of report.by_type) {
  console.log(
    `  ${s.action_type.padEnd(9)} ${String(s.executed).padStart(8)}  ${String(s.rejected).padStart(8)}  ` +
      `${String(s.deferred).padStart(8)}  ${String(s.decided).padStart(7)}  ` +
      `${s.precision == null ? "n/a" : s.precision.toFixed(3)}${s.small_n ? "  ⚠️n 过小" : ""}`,
  );
}
