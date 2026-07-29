#!/usr/bin/env -S npx tsx
// Seed the direct-API cursors (_slackDirect / _gmailDirect) to "now" so the
// notification daemon starts incremental from this moment — it only picks up
// messages that arrive AFTER seeding, instead of cold-bootstrapping the whole
// recent backlog. Run once before starting the daemon in notification mode.
//
//   npx tsx scripts/seed-cursors-now.ts [--state path]
//
// Gmail: per-mailbox historyId = the current profile historyId.
// Slack:  per IM/MPIM channel lastTs = now (epoch seconds).

import { resolve } from "node:path";
import { dirname } from "node:path";
import { acquireLock, loadState, releaseLock, saveState } from "../relay/io/state.js";
import { createSlackClientFromKeychain } from "../relay/io/slack-api.js";
import { GmailClient } from "../relay/io/gmail-api.js";
import { KNOWN_MAILBOXES } from "../relay/io/google-oauth.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main(): Promise<void> {
  const statePath = resolve(arg("--state", resolve(process.cwd(), "state/loop-state.json")));
  const nowTs = `${Math.floor(Date.now() / 1000)}.000000`;

  // Gmail historyIds (network, do BEFORE taking the lock)
  const gmailCursors: Record<string, { historyId: string }> = {};
  for (const email of KNOWN_MAILBOXES) {
    try {
      const profile = await new GmailClient({ email }).getProfile();
      gmailCursors[email] = { historyId: profile.historyId };
      console.log(`  gmail ${email}: historyId=${profile.historyId}`);
    } catch (e) {
      console.error(`  gmail ${email}: SKIP (${(e as Error).message.split("\n")[0]})`);
    }
  }

  // Slack channels
  const slackChannels: Record<string, { lastTs: string }> = {};
  try {
    const slack = await createSlackClientFromKeychain();
    const all = await slack.listAllConversations();
    const chans = all.filter((c) => c.is_im === true || c.is_mpim === true);
    for (const c of chans) slackChannels[c.id] = { lastTs: nowTs };
    console.log(`  slack: seeded ${chans.length} IM/MPIM channels to ts=${nowTs}`);
  } catch (e) {
    console.error(`  slack: SKIP (${(e as Error).message.split("\n")[0]})`);
  }

  const stateDir = dirname(statePath);
  if (!acquireLock(stateDir)) throw new Error("could not acquire state lock");
  try {
    const state = loadState(statePath);
    const marks = state.marks as unknown as {
      _gmailDirect?: { mailboxes: Record<string, { historyId: string }> };
      _slackDirect?: { channels: Record<string, { lastTs: string }> };
    };
    marks._gmailDirect = { mailboxes: { ...(marks._gmailDirect?.mailboxes ?? {}), ...gmailCursors } };
    marks._slackDirect = { channels: { ...(marks._slackDirect?.channels ?? {}), ...slackChannels } };
    saveState(statePath, state);
    console.log(`\nseeded cursors to now -> ${statePath}`);
  } finally {
    releaseLock(stateDir);
  }
}

main().catch((e) => { console.error("seed crashed:", (e as Error).message); process.exit(1); });
