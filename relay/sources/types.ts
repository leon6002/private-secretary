// MessageSource contract. Adding a source = a new file with a normalize() pure
// function + a registry entry + a skill poll section. The pipeline (cursor-check,
// filter, round-commit) never changes — sources only produce InboundMessage[].
//
// poll() I/O lives in the skill (Claude calls the platform MCP). normalize() is the
// deterministic, unit-tested transform from a platform's raw payload to the common
// InboundMessage shape, including the "addressed to user" facts the trigger filter
// reads. Sources are keyed by ACCOUNT INSTANCE (e.g. "slack:taiv"), so Phase 2's
// multi-account fan-out is additive — see specs/action-item-engine.md.

import type { InboundMessage, Platform } from "../core/types.js";

// Self-identifiers, supplied by the skill (it knows the logged-in ids per platform),
// used to compute mention/assignment facts deterministically.
export interface SourceContext {
  selfSlackId?: string; // e.g. UPHG4T8R1
  selfEmail?: string; // e.g. leo@taiv.tv
  selfJiraAccountId?: string;
  selfNotionId?: string;
}

export interface MessageSource {
  key: string; // registry key, e.g. "jira"
  platform: Platform;
  normalize(raw: unknown, ctx: SourceContext): InboundMessage[];
}

// Slack ts ("1781140064.001200") -> epoch ms. Returns 0 on a malformed value so a
// bad row sorts to the start rather than throwing the whole batch.
export function slackTsToMs(ts: unknown): number {
  const n = typeof ts === "string" ? parseFloat(ts) : NaN;
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

// ISO 8601 -> epoch ms, 0 on failure.
export function isoToMs(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}
