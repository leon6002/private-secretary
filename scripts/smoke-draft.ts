#!/usr/bin/env -S npx tsx
// Controlled live smoke for the LLM drafting path. Uses the real
// Anthropic key (Keychain taiv-secretary-anthropic) + real personas, but
// a SYNTHETIC inbound message — one cheap call, no real private data,
// no cold-cursor backlog. Proves: key → Messages API → forced tool-use →
// structured output → validateActionItem → ActionItem, with persona
// context resolved.
//
//   npx tsx scripts/smoke-draft.ts
//
// Needs: security add-generic-password -U -s taiv-secretary-anthropic \
//          -a leo@taiv.tv -w 'sk-ant-...'

import { resolve as resolvePath } from "node:path";
import { createAnthropicLlmCaller } from "../relay/proc/llm-anthropic.js";
import { buildPersonaResolver, draftActions } from "../relay/proc/draft.js";
import { loadPersonas } from "../relay/io/personas.js";
import type { InboundMessage } from "../relay/core/types.js";

async function main(): Promise<void> {
  const personaDir = resolvePath(process.cwd(), "personas");
  const personas = loadPersonas(personaDir);
  const { resolve, keys } = buildPersonaResolver(personas);
  console.log(`personas indexed: ${keys.length}`);

  // Synthetic Slack DM from a known persona (michael-dobosz). Two messages
  // from one sender → one analysis, exercising grouping + persona context.
  const michael = personas.find((p) => p.key === "michael-dobosz");
  const handle = michael?.handles?.slack ?? "UR36HT3HV";

  const candidates: InboundMessage[] = [
    {
      id: "slack:DSMOKE:1.0001",
      platform: "slack",
      senderHandle: handle,
      timestampMs: 1781400000000,
      text: "for the rev5 board should we stick with the 25-30W supply or bump it? the NPU load worries me",
      source: "slack:DSMOKE",
      isDirectMessage: true,
      mentionsUser: true,
      isReplyInUserThread: false,
      recipientsIncludeUser: false,
      threadAnsweredByUserAfter: false,
    },
    {
      id: "slack:DSMOKE:2.0002",
      platform: "slack",
      senderHandle: handle,
      timestampMs: 1781400060000,
      text: "also can you send me what we paid for the ap6275s module on rev4?",
      source: "slack:DSMOKE",
      isDirectMessage: true,
      mentionsUser: true,
      isReplyInUserThread: false,
      recipientsIncludeUser: false,
      threadAnsweredByUserAfter: false,
    },
  ];

  const llm = await createAnthropicLlmCaller();
  console.log("calling Anthropic (forced tool-use)...");
  const t0 = Date.now();
  const r = await draftActions(candidates, { llm, resolvePersona: resolve, knownPersonaKeys: keys });
  console.log(`done in ${Date.now() - t0}ms — actions=${r.actions.length} errors=${r.errors.length} dropped=${r.dropped.length}`);

  for (const a of r.actions) {
    console.log("\n--- ActionItem ---");
    console.log(`type=${a.action_type} confidence=${a.confidence}`);
    console.log(`target=${JSON.stringify(a.target)}`);
    console.log(`reason=${a.reason}`);
    if (a.draft) console.log(`draft=${a.draft}`);
    if (a.params && Object.keys(a.params).length) console.log(`params=${JSON.stringify(a.params)}`);
  }
  if (r.errors.length) console.log("\nerrors:", JSON.stringify(r.errors, null, 2));

  // Pass criterion: at least one validated action, no LLM errors.
  const ok = r.actions.length > 0 && r.errors.length === 0;
  console.log(`\n${ok ? "✓ PASS" : "✗ FAIL"}: drafting path live`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", (e as Error).message);
  process.exit(2);
});
