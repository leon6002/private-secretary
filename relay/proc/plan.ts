// Daily-plan (ranking) pass (specs/daily-todo.md). Groups the open cards into
// task units (same keying the cockpit uses: task_id, or "__ungrouped_<id>" for a
// standalone card), asks the LLM to rank them A→D with a "why now" + entities,
// and returns a TaskPlanMap to store in loop-state. Pure-core split: the LLM
// ranks, this module just groups + validates + stamps.

import type { ActionItem } from "../core/action-item.js";
import type { TaskRegistry, TaskPlanMap } from "../core/tasks.js";
import { buildPlanRequest, parseRankings, type PlanRequest, type PlanUnit } from "./plan-prompt.js";

export type PlanJsonCaller = (req: PlanRequest) => Promise<unknown>;

export interface PlanDeps {
  json: PlanJsonCaller;
  now?: () => string;
  nowMs?: () => number;
}

// The cockpit + plan share this unit key so a plan attaches to its cluster.
export function unitKey(a: ActionItem): string {
  return a.task_id ?? `__ungrouped_${a.id}`;
}

export async function rankTasks(
  openActions: ActionItem[],
  registry: TaskRegistry,
  deps: PlanDeps,
): Promise<TaskPlanMap> {
  if (openActions.length === 0) return {};
  const now = deps.now ?? (() => new Date().toISOString());
  const nowMs = (deps.nowMs ?? (() => Date.now()))();

  // Group open cards into task units.
  const units = new Map<string, PlanUnit & { _oldestMs: number }>();
  for (const a of openActions) {
    const key = unitKey(a);
    const cur = units.get(key);
    const createdMs = Date.parse(a.created_at) || nowMs;
    const step = a.headline || (typeof a.params?.title === "string" ? a.params.title : "") || a.reason || "";
    if (!cur) {
      units.set(key, {
        key,
        title: (a.task_id && registry[a.task_id]?.title) || a.headline || step || "(untitled task)",
        project: a.project_id && a.project_id !== "MISC" ? a.project_id : undefined,
        subActions: step ? [step] : [],
        _oldestMs: createdMs,
      });
    } else {
      if (step) cur.subActions.push(step);
      if (createdMs < cur._oldestMs) cur._oldestMs = createdMs;
    }
  }
  const unitList: PlanUnit[] = [...units.values()].map((u) => ({
    key: u.key,
    title: u.title,
    project: u.project,
    subActions: u.subActions.slice(0, 6),
    ageHours: (nowMs - u._oldestMs) / 3_600_000,
  }));

  const rankings = parseRankings(await deps.json(buildPlanRequest(unitList)));
  if (rankings.length === 0) return {};

  const validKeys = new Set(unitList.map((u) => u.key));
  const at = now();
  const plans: TaskPlanMap = {};
  let rank = 0;
  for (const r of rankings) {
    if (!validKeys.has(r.key) || plans[r.key]) continue; // ignore hallucinated / dup keys
    const entities = Array.isArray(r.entities)
      ? r.entities
          .filter((e) => e && typeof e.kind === "string" && typeof e.label === "string")
          .map((e) => ({ kind: e.kind, label: e.label, value: e.value, source: e.source }))
      : undefined;
    plans[r.key] = { tier: r.tier, rank: rank++, why: r.why, ...(entities && entities.length ? { entities } : {}), at };
  }
  return plans;
}
