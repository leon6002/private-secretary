#!/usr/bin/env -S npx tsx
// Launch the secretary cockpit — the localhost triage UI. Loopback-only,
// CSRF-guarded. Approve drives the real Direct-API executors (Slack send /
// Gmail draft / Calendar create) wired from Keychain.
//
//   npx tsx scripts/run-cockpit.ts                 # default port 4317
//   npx tsx scripts/run-cockpit.ts --port 5000
//   npx tsx scripts/run-cockpit.ts --no-open       # don't auto-open browser
//
// The daemon (scripts/run-secretary.ts) fills the queue; this is where you
// triage it. They share state/loop-state.json via the single-writer lock.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startCockpit } from "../relay/cockpit/server.js";
import { createWiredExecutor } from "../relay/cockpit/wire-executor.js";
import { createDryExecutor } from "../relay/cockpit/dry-executor.js";

interface Args {
  statePath: string;
  personaDir: string;
  projectsDir: string;
  port: number;
  open: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let statePath = resolve(process.cwd(), "state/loop-state.json");
  let personaDir = resolve(process.cwd(), "personas");
  let projectsDir = resolve(process.cwd(), "projects/_staged");
  let port = 4317;
  let open = true;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--state") statePath = resolve(argv[++i] ?? "");
    else if (a === "--personas") personaDir = resolve(argv[++i] ?? "");
    else if (a === "--projects") projectsDir = resolve(argv[++i] ?? "");
    else if (a === "--port") port = Number(argv[++i]);
    else if (a === "--no-open") open = false;
    else if (a === "--dry-run") dryRun = true;
  }
  return { statePath, personaDir, projectsDir, port, open, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cockpit = await startCockpit({
    statePath: args.statePath,
    personaDir: args.personaDir,
    projectsDir: args.projectsDir,
    port: args.port,
    executor: args.dryRun ? createDryExecutor() : createWiredExecutor(),
  });
  console.log(`[cockpit] serving ${cockpit.url}`);
  console.log(`[cockpit] state=${args.statePath}`);
  if (args.dryRun) {
    console.log(`[cockpit] ⚠ DRY-RUN: approve runs the full flow but sends NOTHING (stub clients)`);
  }
  if (args.open) {
    // macOS `open`; harmless no-op message elsewhere.
    spawn("open", [cockpit.url], { detached: true, stdio: "ignore" }).unref();
  }
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[cockpit] ${sig} — closing`);
    await cockpit.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[cockpit] failed:", (e as Error).message);
  process.exit(1);
});
