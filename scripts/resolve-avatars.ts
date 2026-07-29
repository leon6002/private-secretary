#!/usr/bin/env -S npx tsx
// One-shot: resolve head photos for personas from Slack (users.info) and write
// state/avatars.json ({ personaKey: imageUrl }). The cockpit's getPeople reads
// that file (best-effort) so the People rail + profile show real faces instead
// of initials. Re-run when personas change. WeChat avatars aren't wired (the
// decrypt MCP doesn't expose them); those personas keep initials.
//
//   npx tsx scripts/resolve-avatars.ts [--personas p] [--out p]

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadPersonas } from "../relay/io/personas.js";
import { createSlackClientFromKeychain } from "../relay/io/slack-api.js";

function arg(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function main(): Promise<void> {
  const personaDir = resolve(arg("--personas", resolve(process.cwd(), "personas")));
  const out = resolve(arg("--out", resolve(process.cwd(), "state/avatars.json")));
  const personas = loadPersonas(personaDir);
  const withSlack = personas.filter((p) => p.handles?.slack);
  console.log(`[avatars] ${personas.length} personas, ${withSlack.length} with a Slack handle`);

  const slack = await createSlackClientFromKeychain();
  const map: Record<string, string> = {};
  let ok = 0;
  for (const p of withSlack) {
    const id = p.handles.slack!;
    try {
      const u = (await slack.usersInfo(id)) as { profile?: Record<string, string> };
      const img = u.profile?.image_512 || u.profile?.image_192 || u.profile?.image_72;
      if (img) {
        map[p.key] = img;
        ok++;
      }
    } catch (e) {
      console.log(`[avatars] skip ${p.key} (${id}): ${(e as Error).message.split("\n")[0]}`);
    }
  }
  writeFileSync(out, JSON.stringify(map, null, 2));
  console.log(`[avatars] wrote ${ok} avatars → ${out}`);
}

main().catch((e) => {
  console.error("[avatars] failed:", (e as Error).message);
  process.exit(1);
});
