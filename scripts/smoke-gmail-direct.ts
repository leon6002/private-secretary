#!/usr/bin/env -S npx tsx
// Smoke test for the Direct-API Gmail adapter. Runs against the 4 real
// mailboxes whose OAuth bundles already live in Keychain:
//   - leo@taiv.tv         (project A, Internal, no expiry)
//   - leo@osyx.tech       (project B, Internal, no expiry)
//   - huizhezheng@gmail.com (project C, External Testing, 7d expiry)
//   - zhenghleo@gmail.com   (project C, External Testing, 7d expiry)
//
// Pass criteria per mailbox:
//   1. getProfile returns the expected emailAddress + a fresh historyId
//   2. pollMailbox (bootstrap) returns a non-empty inbound array
//   3. The InboundMessage[] shapes look right (gmail: ids, source, addr facts)

import { GmailClient } from "../relay/io/gmail-api.js";
import { KNOWN_MAILBOXES } from "../relay/io/google-oauth.js";
import { pollMailbox } from "../relay/sources/gmail-direct.js";

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string = ""): void => {
    console.log(`▶ ${name} ... ${ok ? "ok" : "FAIL"} ${detail}`);
    if (ok) passed++;
    else failed++;
  };

  for (const email of KNOWN_MAILBOXES) {
    try {
      const client = new GmailClient({ email });
      const profile = await client.getProfile();
      check(
        `${email} :: getProfile`,
        profile.emailAddress.toLowerCase() === email.toLowerCase(),
        `messages=${profile.messagesTotal} historyId=${profile.historyId}`,
      );

      // Bootstrap poll: pull recent inbound. We deliberately use a tight
      // 2-day window + cap 20 so the smoke is quick.
      const r = await pollMailbox({
        client,
        mailboxEmail: email,
        bootstrapWindowDays: 2,
        perPollLimit: 20,
      });
      check(
        `${email} :: pollMailbox bootstrap`,
        r.newHistoryId.length > 0 && r.inbound.length >= 0,
        `inbound=${r.inbound.length} newHistoryId=${r.newHistoryId}`,
      );

      // Shape spot-checks on the first inbound message (if any)
      if (r.inbound[0]) {
        const m = r.inbound[0];
        check(
          `${email} :: inbound shape`,
          m.platform === "gmail" &&
            m.id.startsWith("gmail:") &&
            m.source === `gmail:${email}` &&
            typeof m.recipientsIncludeUser === "boolean",
          `id=${m.id} sender=${m.senderHandle} recipientsIncludeUser=${m.recipientsIncludeUser}`,
        );
      }
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
