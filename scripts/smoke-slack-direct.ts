#!/usr/bin/env -S npx tsx
// Smoke test for the Direct-API Slack adapter. Run against real Slack
// using the xoxp- token in Keychain (taiv-secretary-slack / leo@taiv.tv).
//
// Pass criteria:
//   1. auth.test returns user_id matching the persona expectation (UPHG4T8R1)
//   2. listAllConversations returns at least 1 IM + 1 channel
//   3. One conversationsHistory call against a known channel returns
//      messages with proper shape
//   4. scanSlackDirect against 3 channels produces InboundMessage[]
//
// No state is written; first poll uses no cursor so everything is "new".

import { createSlackClientFromKeychain } from "../relay/io/slack-api.js";
import { scanSlackDirect } from "../relay/sources/slack-direct.js";

async function main(): Promise<void> {
  const client = await createSlackClientFromKeychain();
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail: string = ""): void => {
    if (ok) {
      console.log(`▶ ${name} ... ok ${detail}`);
      passed++;
    } else {
      console.log(`▶ ${name} ... FAIL ${detail}`);
      failed++;
    }
  };

  const auth = await client.authTest();
  check(
    "auth.test",
    auth.user_id === "UPHG4T8R1",
    `user_id=${auth.user_id} team=${auth.team}`,
  );

  const all = await client.listAllConversations();
  const ims = all.filter((c) => c.is_im);
  const channels = all.filter((c) => c.is_channel || c.is_group);
  check(
    "listAllConversations",
    ims.length > 0 && channels.length > 0,
    `${all.length} total: ${ims.length} IM, ${channels.length} channels`,
  );

  if (channels.length > 0) {
    const c = channels[0]!;
    const hist = await client.conversationsHistory({ channel: c.id, limit: 5 });
    check(
      "conversationsHistory (first channel, 5 msgs)",
      hist.messages.length > 0,
      `channel=${c.id} (${c.name}) got ${hist.messages.length} msgs`,
    );
  }

  // Mini scan: pick 3 active channels for a smoke poll. We don't want to
  // hammer 100+ channels in a smoke, so cap.
  const sample = all.filter((c) => !c.is_archived).slice(0, 3);
  const r = await scanSlackDirect({ client, channels: sample });
  check(
    "scanSlackDirect (3 channels)",
    r.inbound.length > 0,
    `${r.inbound.length} InboundMessages, ${Object.keys(r.nextState.channels).length} cursors`,
  );

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("smoke crashed:", (e as Error).message);
  process.exit(2);
});
