// One-time migration (P0 task 1.3): export every terminal action currently in
// loop-state.json into the append-only label ledger.
//
// WHY: loop-state.json is a live working set that evicts records from two paths
// (the MAX_TERMINAL_ACTIONS prune and the supersede filter). Those records are
// the only ground truth we have for measuring accuracy. This snapshots what
// still survives before any more of it is lost.
//
// Historical records carry decided_at=null and existence=null — the decision
// timestamp and the reject reason were never recorded. That gap is exactly what
// the cockpit instrumentation (task 2) fixes going forward.
//
// IDEMPOTENT: re-running skips action_ids already in the ledger, so it is safe
// to run twice. Never rewrites an existing line.
//
//   npx tsx scripts/export-labels.ts [--state state/loop-state.json] [--dry-run]

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadState } from "../relay/io/state.js";
import { appendLabels, buildLabel, labelsPathFor, readLabels, type LabelDecision } from "../relay/io/labels.js";

const argv = process.argv.slice(2);
const statePath =
  argv.includes("--state") ? argv[argv.indexOf("--state") + 1]! : "state/loop-state.json";
const dryRun = argv.includes("--dry-run");

const TERMINAL = new Set(["executed", "rejected"]);

function gitSha(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

const state = loadState(statePath);
const labelsPath = labelsPathFor(statePath);

// Idempotency: don't double-export an action we already rescued.
const already = new Set<string>();
if (existsSync(labelsPath)) {
  for (const r of readLabels(readFileSync(labelsPath, "utf8"))) already.add(r.action_id);
}

const terminal = state.actions.filter((a) => TERMINAL.has(a.status));
const fresh = terminal.filter((a) => !already.has(a.id));
const sha = gitSha();

const records = fresh.map((a) =>
  buildLabel({
    action: a,
    decision: a.status as LabelDecision, // "executed" | "rejected"
    // decided_at / existence intentionally null — never recorded historically.
    git_sha: sha,
  }),
);

if (!dryRun) appendLabels(labelsPath, records);

// ── report ──────────────────────────────────────────────────────────
const byType = new Map<string, { executed: number; rejected: number }>();
for (const a of terminal) {
  const c = byType.get(a.action_type) ?? { executed: 0, rejected: 0 };
  if (a.status === "executed") c.executed++;
  else c.rejected++;
  byType.set(a.action_type, c);
}

const statusCounts = new Map<string, number>();
for (const a of state.actions) statusCounts.set(a.status, (statusCounts.get(a.status) ?? 0) + 1);

console.log(`${dryRun ? "[DRY RUN] " : ""}export-labels — ${statePath} → ${labelsPath}`);
console.log(`  actions in state:      ${state.actions.length}`);
console.log(`  terminal (labelable):  ${terminal.length}`);
console.log(`  already in ledger:     ${terminal.length - fresh.length}`);
console.log(`  exported this run:     ${records.length}`);
console.log(`  status distribution:   ${[...statusCounts].map(([s, n]) => `${s}=${n}`).join(" ")}`);
console.log("");
console.log("  per action_type (of the terminal set):");
console.log("    type      executed  rejected  decided   precision");
for (const [type, c] of [...byType].sort((a, b) => b[1].executed + b[1].rejected - (a[1].executed + a[1].rejected))) {
  const decided = c.executed + c.rejected;
  const p = decided > 0 ? (c.executed / decided).toFixed(3) : "n/a";
  const small = decided < 10 ? "  ← n 过小,仅供参考" : "";
  console.log(
    `    ${type.padEnd(9)} ${String(c.executed).padStart(8)}  ${String(c.rejected).padStart(8)}  ` +
      `${String(decided).padStart(7)}   ${p}${small}`,
  );
}
console.log("");
// The whole point of the migration: prove how thin the historical labels are.
const withDecidedAt = terminal.filter((a) => (a as { decided_at?: unknown }).decided_at != null).length;
console.log(`  decided_at present in source state: ${withDecidedAt} / ${terminal.length}  (expected 0 — this is what task 2 fixes)`);
