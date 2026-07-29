#!/usr/bin/env -S npx tsx
// P6 slice 2 — on-demand web research for a card. Run by Leo (or a future cockpit
// "research" button) on a SPECIFIC question; NOT part of the scan loop.
//
//   npx tsx scripts/research.ts "hotels near Hangzhou East Railway Station for Tuesday"
//   npx tsx scripts/research.ts --hotels "客户地址" [--date "2026-06-30"]

import { createClaudeCliResearchCaller } from "../relay/proc/llm-claude-cli.js";
import { runResearch, hotelQuery } from "../relay/proc/research.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const research = createClaudeCliResearchCaller({ model: "opus" });
  const near = flag("--hotels");
  const question = near
    ? hotelQuery({ near, date: flag("--date") })
    : process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ");
  if (!question) {
    console.error('usage: research.ts "<question>"  |  research.ts --hotels "<site>" [--date "<when>"]');
    process.exit(1);
  }
  console.error(`[research] ${question}\n`);
  const answer = await runResearch(question, { research });
  console.log(answer);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
