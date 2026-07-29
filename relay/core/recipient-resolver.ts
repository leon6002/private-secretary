// Recipient resolver: maps platform handles -> personas, and applies the
// ASK-not-GUESS safety rule. Wrong-recipient is the worst failure mode, so resolution
// resolves ONLY on an exact, unambiguous match; anything else returns "unresolved" and
// the UI asks the user to pick. We never auto-target a guessed handle.
//
// The risky judgment (extracting candidate names from message text) lives in the LLM
// layer ABOVE this. This core takes candidate identifiers and applies the deterministic
// exactly-one-match rule.

import type { Persona, Platform } from "./types.js";

// handle/key/displayName -> personaKey
export type ReverseIndex = Map<string, string>;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// Build the reverse index from all personas. Rebuilt every pass (cheap, 5-10 files),
// never persisted — so newly created/edited personas always resolve.
export function buildReverseIndex(personas: Persona[]): ReverseIndex {
  const index: ReverseIndex = new Map();
  for (const p of personas) {
    index.set(norm(p.key), p.key);
    index.set(norm(p.displayName), p.key);
    for (const handle of Object.values(p.handles)) {
      if (handle) index.set(norm(handle), p.key);
    }
  }
  return index;
}

export function resolveSender(
  senderHandle: string,
  index: ReverseIndex,
): string | null {
  return index.get(norm(senderHandle)) ?? null;
}

export type RecipientResolution =
  | { status: "resolved"; personaKey: string }
  | { status: "unresolved"; reason: "no-match" | "ambiguous" };

// Resolve a recipient from candidate identifiers (handles, keys, or names the upstream
// extracted). Resolved ONLY if the candidates point to exactly one distinct persona.
export function resolveRecipient(
  candidates: string[],
  index: ReverseIndex,
): RecipientResolution {
  const matched = new Set<string>();
  for (const c of candidates) {
    const key = index.get(norm(c));
    if (key) matched.add(key);
  }
  if (matched.size === 1) {
    return { status: "resolved", personaKey: [...matched][0]! };
  }
  return {
    status: "unresolved",
    reason: matched.size === 0 ? "no-match" : "ambiguous",
  };
}

// Direction inference for an unknown sender: if they wrote in zh, we draft the relay in
// en (toward the English Slack side), and vice versa. Used only when no persona exists.
export function inferDirectionLanguage(inboundLanguage: "en" | "zh"): "en" | "zh" {
  return inboundLanguage === "zh" ? "en" : "zh";
}

export function targetRequiresManualSend(platform: Platform): boolean {
  return platform === "wechat";
}
