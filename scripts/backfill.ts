#!/usr/bin/env -S npx tsx
// Rewind the read cursors so the next scan re-reads a window of history.
//
// Why this exists: the queue only fills as fast as people message you, which
// is too slow to see what the engine actually does. Rewinding the cursors
// makes the next round read a week or a month at once, and every message that
// was never processed becomes a real card through the real pipeline — not a
// fixture, not a mock.
//
// There are TWO cursors per source and both have to move, which is not
// obvious and is worth spelling out:
//   - `_slackDirect.channels[x].lastTs` decides what Slack RETURNS.
//   - `marks["slack:x"].lastTimestampMs` decides what dedup ACCEPTS
//     (relay/core/dedup.ts: a message is new only if it is newer than this).
// Rewinding only the first fetches the history and then throws all of it away.
//
// `seenIds` is left alone. It is a 50-entry ring per source, and it is what
// stops the most recently handled messages from being surfaced twice — the
// `dedup-survives-restart` regression. Clearing it to "get more cards" would
// put that bug straight back.
//
// THE TRADE, stated plainly: beyond those 50 entries, lowering the high-water
// mark means messages that were already turned into cards can become cards
// again. Nothing can be SENT by this — a regenerated card arrives as
// `suggested` and still needs approval — but the queue can show work you have
// already done. That is the price of replaying history, and it is why this
// writes a backup and is not something the daemon ever does on its own.
//
// Usage:
//   npx tsx scripts/backfill.ts --days 30              # dry run, prints the plan
//   npx tsx scripts/backfill.ts --days 30 --apply      # writes it
//
// Stop the daemon first, or run it while the daemon is between rounds: this
// takes the same lock the scan does, so a concurrent round will simply wait.

import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { acquireLock, loadState, releaseLock, saveState } from "../relay/io/state.js";

interface Args {
  statePath: string;
  days: number;
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const num = (flag: string, dflt: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return dflt;
    const v = Number(argv[i + 1]);
    if (!Number.isInteger(v) || v < 1 || v > 365) {
      throw new Error(`${flag} must be a whole number of days, 1 to 365`);
    }
    return v;
  };
  const str = (flag: string, dflt: string): string => {
    const i = argv.indexOf(flag);
    return i === -1 ? dflt : (argv[i + 1] ?? dflt);
  };
  return {
    statePath: resolve(str("--state", resolve(process.cwd(), "state/loop-state.json"))),
    days: num("--days", 7),
    apply: argv.includes("--apply"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cutoffMs = Date.now() - args.days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  console.log(`[backfill] window: ${args.days} days (back to ${cutoffIso})`);
  console.log(`[backfill] state:  ${args.statePath}`);
  if (!args.apply) console.log(`[backfill] DRY RUN — nothing is written. Re-run with --apply.`);

  // The lock lives beside the state file and guards the same single-writer
  // invariant the scan uses, so a round in flight cannot half-see this write.
  const stateDir = dirname(args.statePath);
  if (args.apply && !acquireLock(stateDir)) {
    throw new Error("a scan round holds the state lock — try again in a moment");
  }
  try {
    const state = loadState(args.statePath);
    const marks = state.marks as Record<string, unknown>;
    const plan: string[] = [];

    // Slack: the cursor is a message ts passed as `oldest`, so rewinding it is
    // just writing an older ts. Channels whose newest message already predates
    // the cutoff are left alone — moving their cursor FORWARD would skip
    // history, which is the opposite of the point.
    const slack = marks._slackDirect as
      | { channels?: Record<string, { lastTs?: string }> }
      | undefined;
    for (const [channel, cur] of Object.entries(slack?.channels ?? {})) {
      const at = Number(cur.lastTs) * 1000;
      if (!Number.isFinite(at) || at <= cutoffMs) {
        plan.push(`slack ${channel}: fetch cursor already at or before the cutoff`);
      } else {
        plan.push(`slack ${channel}: fetch ${new Date(at).toISOString()} → ${cutoffIso}`);
        if (args.apply) cur.lastTs = String(Math.floor(cutoffMs / 1000));
      }
    }

    // The dedup high-water marks, one per source key ("slack:<channel>",
    // "gmail:<mailbox>"). Without these the fetched history is read and then
    // discarded, so the whole run would look like a no-op.
    for (const [key, raw] of Object.entries(marks)) {
      if (key.startsWith("_")) continue; // the fetch cursors, handled above
      const hwm = raw as { lastTimestampMs?: number };
      if (typeof hwm.lastTimestampMs !== "number" || hwm.lastTimestampMs <= cutoffMs) continue;
      plan.push(
        `dedup ${key}: accept from ${new Date(hwm.lastTimestampMs).toISOString()} → ${cutoffIso}`,
      );
      if (args.apply) hwm.lastTimestampMs = cutoffMs;
    }

    // Gmail has no rewindable cursor: historyId is a server-side sequence, not
    // a date. Dropping it puts the mailbox back into bootstrap, which seeds
    // from `newer_than:Nd` instead — a different mechanism reaching the same
    // place. Its window is the source's own default (7 days) and it only picks
    // up UNREAD mail, so an old thread you have already read stays invisible.
    const gmail = marks._gmailDirect as
      | { mailboxes?: Record<string, { historyId?: string }> }
      | undefined;
    for (const mailbox of Object.keys(gmail?.mailboxes ?? {})) {
      plan.push(`gmail ${mailbox}: drop historyId → re-bootstrap (unread, last 7d)`);
      if (args.apply) delete gmail!.mailboxes![mailbox];
    }

    for (const line of plan) console.log(`  ${line}`);
    if (plan.length === 0) console.log("  nothing to rewind");

    const seen = Object.entries(marks)
      .filter(([, v]) => Array.isArray((v as { seenIds?: unknown[] })?.seenIds))
      .map(([k, v]) => `${k}=${(v as { seenIds: unknown[] }).seenIds.length}`);
    console.log(`[backfill] seenIds rings left untouched: ${seen.join(" ") || "none"}`);
    console.log(
      "[backfill] beyond those rings, already-handled messages can come back as" +
        " fresh suggested cards. Nothing sends without approval.",
    );

    if (args.apply) {
      copyFileSync(args.statePath, `${args.statePath}.pre-backfill`);
      saveState(args.statePath, state);
      console.log(`[backfill] written. Backup: ${args.statePath}.pre-backfill`);
      console.log(`[backfill] the next scan round will read the window.`);
    }
  } finally {
    if (args.apply) releaseLock(stateDir);
  }
}

main().catch((e) => {
  console.error(`[backfill] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
