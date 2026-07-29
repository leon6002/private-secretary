// Executor contract. Execution I/O (MCP sends, calendar calls) lives in the skill;
// the rules about WHAT may execute and WHEN live here, tested.

import { missingInfo, type ActionItem, type ActionType } from "./action-item.js";

// V1 hard rule (spec): these types ALWAYS need human confirmation. Hard-coded on
// purpose — not configurable, cannot be overridden.
export const ALWAYS_CONFIRM: ReadonlySet<ActionType> = new Set([
  "calendar",
  "reply",
  "relay",
  "forward",
]);

// Auto-execute threshold for low-risk types (ignore, task). Hard-coded constant,
// no config system (V1 hard decision). Used by PR 2's auto-archive; the rule is
// defined and tested here so it cannot drift.
export const AUTO_EXECUTE_CONFIDENCE = 0.9;

export function canAutoExecute(a: ActionItem): boolean {
  if (a.status !== "suggested") return false;
  if (ALWAYS_CONFIRM.has(a.action_type)) return false;
  if (a.confidence < AUTO_EXECUTE_CONFIDENCE) return false;
  return missingInfo(a).length === 0;
}
