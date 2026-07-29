// P10 — multi-party awareness. When a message/thread involves OTHER known contacts
// (a decision with 古龙 that also affects 金小奇), the drafter should see those
// people's conversations too. This detects which known personas are MENTIONED in
// the text so the caller can pull their recent thread + let the drafter act on the
// third party. Pure logic — the thread fetch + injection live in proc/draft.ts.

import type { Persona } from "./types.js";

// Alias tokens to scan for: the full displayName, its first whitespace token (drop
// org suffixes like "金小奇 芯联集成" → "金小奇"), and — for a CJK name — the
// "X总" business honorific (金小奇 → 金总), which is how people are referenced in
// chat. Latin names also expose the first name. All length >= 2 to avoid noise.
export function personaAliases(p: Persona): string[] {
  const out = new Set<string>();
  const dn = (p.displayName ?? "").trim();
  if (dn.length >= 2) out.add(dn);
  const firstTok = dn.split(/\s+/)[0] ?? "";
  if (firstTok.length >= 2) out.add(firstTok);
  const c0 = dn[0] ?? "";
  if (c0 && /[一-鿿]/.test(c0)) out.add(`${c0}总`);
  return [...out].filter((a) => a.length >= 2);
}

// Persona keys MENTIONED in `text`, excluding the sender (excludeKey). A persona is
// mentioned when any alias appears as a substring. Capped at `limit` — the third
// parties whose conversation may matter for THIS draft.
export function detectMentions(
  text: string,
  personas: Persona[],
  opts: { excludeKey?: string; limit?: number } = {},
): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const p of personas) {
    if (p.key === opts.excludeKey) continue;
    if (personaAliases(p).some((a) => text.includes(a))) hits.push(p.key);
  }
  return hits.slice(0, opts.limit ?? 2);
}
