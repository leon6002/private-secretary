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

// Auto-execute threshold for low-risk types — IGNORE ONLY. Hard-coded
// constant, no config system (V1 hard decision). Used by the auto-archive
// flush; the rule is defined and tested here so it cannot drift.
//
// 2026-07-31: narrowed from "ignore + task" to ignore-only. An ignore card
// is noise reduction (the engine judged this needs no one) — safe to
// auto-clear. A task card is somebody's request; auto-completing it marks
// work DONE that no human did (the 报销单 incident in dogfooding), which
// contradicts the product's core promise. Tasks now always wait for a human.
export const AUTO_EXECUTE_CONFIDENCE = 0.9;

export function canAutoExecute(a: ActionItem): boolean {
  if (a.status !== "suggested") return false;
  if (a.action_type !== "ignore") return false;
  if (a.confidence < AUTO_EXECUTE_CONFIDENCE) return false;
  return missingInfo(a).length === 0;
}
