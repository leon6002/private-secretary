#!/usr/bin/env -S npx tsx
// One-off cleanup (2026-08-02): delete the bogus Google Calendar events the
// refresh pass's un-anchored dates created. The refresh pass generated
// calendar cards with hallucinated dates (2023/2024/2025, even a +16:00
// offset); the user approved them and each became a REAL event.
//
// Selection rule: an executed calendar action whose receipt ref exists and
// whose params.start year is BEFORE 2026 is bogus — the three legitimate
// events (Q3 预算评审 2026-08-02 / 项目评审会 2026-08-05 / 视频对齐
// 2026-08-07) all start in 2026. Deletion is by exact event ID from the
// execution receipt — nothing else on the calendar is touched.
//
//   npx tsx scripts/cleanup-bogus-events.ts [--state state/loop-state.json] [--yes]
// Without --yes it only prints the plan.

import { loadState } from "../relay/io/state.js";
import { CalendarClient } from "../relay/io/calendar-api.js";
import { loadIdentity } from "../relay/io/identity.js";
import { appendActivity, activityPathFor } from "../relay/io/activity-log.js";

const argv = process.argv.slice(2);
const statePath = argv.includes("--state") ? argv[argv.indexOf("--state") + 1]! : "state/loop-state.json";
const yes = argv.includes("--yes");

const state = loadState(statePath);
const bogus: Array<{ ref: string; headline: string; start: string }> = [];
for (const a of state.actions) {
  if (a.action_type !== "calendar" || a.status !== "executed") continue;
  const p = (a.params ?? {}) as Record<string, unknown>;
  const rec = (p.execution_receipt ?? {}) as { kind?: string; ref?: string };
  const start = typeof p.start === "string" ? p.start : "";
  if (rec.kind !== "calendar_event" || !rec.ref || rec.ref === "DRY-RUN-EVENT") continue;
  if (new Date(start).getFullYear() >= 2026) continue; // legitimate
  bogus.push({ ref: rec.ref, headline: a.headline ?? "", start });
}

console.log(`${bogus.length} bogus event(s) to delete:`);
for (const b of bogus) console.log(`  ${b.start}  ${b.headline}  (${b.ref})`);
if (!yes) {
  console.log("\ndry run — pass --yes to delete.");
  process.exit(0);
}

const client = new CalendarClient({ email: loadIdentity().calendarMailbox });
let deleted = 0;
for (const b of bogus) {
  try {
    await client.deleteEvent({ eventId: b.ref });
    deleted++;
    console.log(`deleted  ${b.start}  ${b.headline}`);
  } catch (e) {
    console.log(`FAILED   ${b.start}  ${b.headline} — ${(e as Error).message}`);
  }
}
appendActivity(activityPathFor(statePath), {
  at: new Date().toISOString(),
  kind: "edit",
  summary: `cleanup: deleted ${deleted}/${bogus.length} bogus calendar events (refresh date-anchor bug)`,
  data: { deleted, total: bogus.length, refs: bogus.map((b) => b.ref) },
});
console.log(`\ndone: ${deleted}/${bogus.length} deleted`);
