#!/usr/bin/env -S npx tsx
// Smoke test for the Direct-API Calendar adapter. Reads events from the
// next 7 days on each of the 4 mailboxes' primary calendars and runs the
// pure conflict-check against a synthetic proposed slot.
//
// Pass criteria per mailbox:
//   1. listEvents returns a (possibly empty) array without throwing
//   2. findConflictsForProposed produces sensible output against a
//      synthetic 3pm-4pm slot tomorrow
//
// No events are created.

import { CalendarClient } from "../relay/io/calendar-api.js";
import { findConflictsForProposed } from "../relay/core/calendar-conflict.js";
import { KNOWN_MAILBOXES } from "../relay/io/google-oauth.js";

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string = ""): void => {
    console.log(`▶ ${name} ... ${ok ? "ok" : "FAIL"} ${detail}`);
    if (ok) passed++;
    else failed++;
  };

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 7 * 86400_000).toISOString();
  const proposedStart = new Date(tomorrow);
  proposedStart.setUTCHours(20, 0, 0, 0); // ~3pm CDT
  const proposedEnd = new Date(proposedStart.getTime() + 60 * 60_000);

  for (const email of KNOWN_MAILBOXES) {
    try {
      const c = new CalendarClient({ email });
      const events = await c.listAllEvents({ timeMin, timeMax });
      check(
        `${email} :: listAllEvents (next 7d)`,
        true,
        `${events.length} events`,
      );

      const conflicts = findConflictsForProposed(
        {
          summary: "Smoke test slot",
          start: { dateTime: proposedStart.toISOString() },
          end: { dateTime: proposedEnd.toISOString() },
        },
        events,
      );
      check(
        `${email} :: findConflicts vs ${proposedStart.toISOString().slice(0, 16)}`,
        true,
        `${conflicts.length} conflict(s)${conflicts[0] ? `: first="${conflicts[0].event.summary ?? "(no title)"}"` : ""}`,
      );
    } catch (e) {
      check(`${email}`, false, `crashed: ${(e as Error).message}`);
    }
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("smoke crashed:", (e as Error).message);
  process.exit(2);
});
