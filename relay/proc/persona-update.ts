// Persona-update pass (Phase B, specs/persona-v3.md): for each contact with an
// open card + a resolved persona, re-read the recent thread, extract NEW
// commitments, and merge them into the persona's Commitments Ledger via the R1
// write chokepoint (writePersonaFile actor="llm" — manual fields never touched,
// evidence required). This is the incremental update the roadmap calls Phase B;
// it is NOT the forbidden full bootstrap.

import type { ActionItem } from "../core/action-item.js";
import type { Persona } from "../core/types.js";
import type { Commitment } from "../core/persona-v3.js";
import { personaPath, readPersonaV3File, writePersonaFile } from "../io/persona-store.js";
import { clusterKey } from "../core/unit-key.js";
import {
  buildPersonaUpdateRequest,
  parseExtractedCommitments,
  type PersonaUpdateRequest,
} from "./persona-update-prompt.js";

export type PersonaUpdateJsonCaller = (req: PersonaUpdateRequest) => Promise<unknown>;

export interface PersonaUpdateDeps {
  json: PersonaUpdateJsonCaller;
  resolvePersona: (handle: string) => Persona | null;
  fetchThread: (card: ActionItem) => Promise<string | null>;
  personaDir: string;
  maxPerTick?: number;
  ttlMs?: number;
  nowMs?: () => number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

// Per-persona cooldown across ticks (module-level; resets on restart).
const lastUpdateMs = new Map<string, number>();

export interface PersonaUpdateResult {
  updated: Array<{ key: string; added: number }>;
}

export async function updatePersonaCommitments(
  openCards: Array<ActionItem & { sender_name?: string }>,
  deps: PersonaUpdateDeps,
): Promise<PersonaUpdateResult> {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const maxPerTick = deps.maxPerTick ?? 3;

  // One representative card per conversation (newest), that resolves to a persona.
  const byPersona = new Map<string, { rep: ActionItem; persona: Persona }>();
  for (const c of openCards) {
    const sender = c.context?.sender_handle;
    if (!sender) continue;
    const persona = deps.resolvePersona(sender);
    if (!persona) continue;
    const cur = byPersona.get(persona.key);
    if (!cur || c.created_at > cur.rep.created_at) byPersona.set(persona.key, { rep: c, persona });
  }

  const eligible = [...byPersona.entries()]
    .filter(([k]) => !lastUpdateMs.has(k) || nowMs - lastUpdateMs.get(k)! >= ttl)
    .sort(([a], [b]) => (lastUpdateMs.get(a) ?? 0) - (lastUpdateMs.get(b) ?? 0))
    .slice(0, maxPerTick);

  const updated: PersonaUpdateResult["updated"] = [];
  for (const [key, { rep, persona }] of eligible) {
    lastUpdateMs.set(key, nowMs); // claim the slot even on a no-op
    const thread = await deps.fetchThread(rep);
    if (!thread) continue;

    const file = personaPath(deps.personaDir, key);
    let existing: Commitment[];
    try {
      existing = readPersonaV3File(file).commitments ?? [];
    } catch {
      continue; // no persona file / unreadable → skip
    }

    let extracted;
    try {
      extracted = parseExtractedCommitments(
        await deps.json(buildPersonaUpdateRequest({ name: persona.displayName, existing, thread })),
      );
    } catch {
      continue; // a single contact's LLM failure must not sink the pass
    }
    const seen = new Set(existing.map((c) => norm(c.what)));
    const fresh = extracted.filter((e) => !seen.has(norm(e.what)));
    if (fresh.length === 0) continue;

    const merged: Commitment[] = [
      ...existing,
      ...fresh.map((e) => ({
        who: e.who,
        what: e.what,
        status: e.status ?? "open",
        ...(e.due ? { due: e.due } : {}),
      })),
    ];
    const evidence =
      fresh.map((e) => e.evidence).filter(Boolean).join(" | ") || "extracted from recent conversation";
    try {
      const res = writePersonaFile(file, { set: { commitments: merged }, evidence: { commitments: evidence } }, "llm");
      if (res.applied.includes("commitments")) updated.push({ key, added: fresh.length });
    } catch {
      /* R1 / validation rejection — skip, non-fatal */
    }
  }

  return { updated };
}

// Same conversation grouping key the rest of the daemon uses.
export { clusterKey };

// Test seam.
export function _resetPersonaUpdateTtl(): void {
  lastUpdateMs.clear();
}
