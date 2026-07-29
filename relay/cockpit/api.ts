// Cockpit API core — the triage operations behind the HTTP endpoints,
// kept free of socket + Keychain concerns so they unit-test without
// network. The server (relay/cockpit/server.ts) wires these to routes
// and supplies the real executor; tests pass a stub executor.
//
// Every mutation goes through relay/io/state's lock + atomic write —
// NEVER raw JSON. Transitions go through relay/core. This is the
// "cockpit writes through core + the existing lock" rule (phase2 eng
// review decision 3).
//
// The cockpit drives the deterministic executor on approve (Phase 3:
// the model never holds send authority). Approve = approveAction
// (validates missing-info) → executeAction (the real side effect) →
// persist the executed/awaiting result. A calendar conflict un-does
// the approval back to suggested so the user can re-time + re-approve.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  approveAction,
  hasReceipt,
  markDone,
  markExecuted,
  missingInfo,
  rejectAction,
  requiresManualExecution,
  restoreAction,
  withReceipt,
  type ActionItem,
  type ExecutionReceipt,
} from "../core/action-item.js";
import { groupByTask, type TaskCluster } from "../core/tasks.js";
import { computeGate, type GateResult } from "../core/metrics.js";
import { canAutoExecute } from "../core/executors.js";
import { provenanceFor, evidenceFor } from "../core/persona-v3.js";
import { loadRawPersonas } from "../io/personas.js";
import { loadProjects } from "../io/projects.js";
import type { Project } from "../core/project.js";
import {
  acquireLock,
  loadState,
  releaseLock,
  saveState,
  type LoopState,
  type SourceError,
} from "../io/state.js";
import {
  appendLabel,
  buildLabel,
  labelsPathFor,
  type EditDiffEntry,
  type ExistenceVerdict,
  type FieldError,
  type LabelDecision,
} from "../io/labels.js";
import type { ExecuteResult } from "../proc/execute.js";

// The executor the cockpit calls on approve. The server injects the real
// one (Keychain-wired Slack/Gmail/Calendar); tests inject a stub. It is
// handed a `persistClaim` so the durable "executing" marker is written
// BEFORE the side effect (crash-safe).
export type CockpitExecutor = (
  action: ActionItem,
  persistClaim: (claimed: ActionItem) => Promise<void>,
) => Promise<ExecuteResult>;

export interface CockpitApiOptions {
  statePath: string;
  personaDir: string;
  // Project RAG dir (the same projects/_staged the daemon drafts against). Used
  // to resolve a card's project_id → name and to render the Projects screen.
  projectsDir?: string;
  executor: CockpitExecutor;
  now?: () => string;
}

// ─── read model ──────────────────────────────────────────────────────

export interface CockpitState {
  // Task-grouped clusters of suggested + in-flight items (oldest-first,
  // ready-first within a group) — the Queue master list.
  clusters: TaskCluster[];
  // Flat slices for badge counts + the awaiting-manual / drawer sections.
  suggested: Array<ActionItem & { missing_info: string[] }>;
  awaitingManual: ActionItem[];
  done: ActionItem[]; // executed (auto-handled drawer + history)
  skipped: ActionItem[]; // rejected (drawer "Skipped")
  sourceErrors: Record<string, SourceError>;
  gate: GateResult;
  counts: {
    pending: number; // suggested
    tasks: number; // distinct task clusters with a pending member
    awaitingManual: number;
  };
}

export class CockpitApi {
  private readonly now: () => string;
  constructor(private readonly opts: CockpitApiOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // Snapshot for the UI. Read-only — no lock needed (atomic writes mean a
  // concurrent reader sees old-or-new bytes, never a torn file).
  // Build a handle/key → display-name resolver from the personas so the
  // cockpit never shows a raw Slack ID / wxid. Indexes every handle, the
  // persona key, and the display name itself (WeChat sender_handle IS the
  // display name). Returns undefined for unknown handles (caller falls back).
  private buildNameResolver(): (x: string | null | undefined) => string | undefined {
    const raw = loadRawPersonas(this.opts.personaDir);
    const byName = new Map<string, string>();
    for (const p of raw) {
      const display = (typeof p.display_name === "string" && p.display_name) || String(p.key ?? "");
      if (!display) continue;
      if (p.key) byName.set(String(p.key).toLowerCase(), display);
      const handles = (p.handles as Record<string, string> | undefined) ?? {};
      for (const h of Object.values(handles)) if (h) byName.set(String(h).toLowerCase(), display);
      byName.set(display.toLowerCase(), display);
    }
    return (x) => (x ? byName.get(String(x).toLowerCase()) : undefined);
  }

  private projectsDir(): string {
    // state/ and projects/ are siblings; fall back to ../projects/_staged when
    // the option isn't set (tests get an empty dir → loadProjects returns []).
    return this.opts.projectsDir ?? join(dirname(dirname(this.opts.statePath)), "projects", "_staged");
  }

  // project_id → display name (name, else id). undefined for MISC / unknown.
  private buildProjectResolver(): (id: string | null | undefined) => string | undefined {
    const byId = new Map<string, string>();
    for (const p of loadProjects(this.projectsDir())) {
      byId.set(p.id, p.name || p.id);
    }
    return (id) => (id && id !== "MISC" ? byId.get(id) : undefined);
  }

  getState(): CockpitState {
    const state = loadState(this.opts.statePath);
    const resolveName = this.buildNameResolver();
    const resolveProject = this.buildProjectResolver();
    // Attach resolved display names (sender + recipient) + project name so the UI
    // shows people + the project a card advances, not raw ids.
    const named = <T extends ActionItem>(a: T): T & { sender_name?: string; recipient_name?: string; project_name?: string } => ({
      ...a,
      sender_name: resolveName(a.context?.sender_handle) ?? a.context?.sender_handle,
      recipient_name:
        resolveName(a.target?.personaKey) ?? a.target?.personaKey ?? a.target?.platform ?? undefined,
      project_name: resolveProject(a.project_id),
    });
    const suggested = state.actions
      .filter((a) => a.status === "suggested")
      .map((a) => named({ ...a, missing_info: missingInfo(a) }));
    const awaitingManual = state.actions.filter(
      (a) => a.status === "approved" && requiresManualExecution(a),
    );
    const done = state.actions.filter((a) => a.status === "executed");
    const skipped = state.actions.filter((a) => a.status === "rejected");

    // Clusters cover the live queue (suggested + approved-not-yet-done).
    // Carry missing_info onto each live action so the UI can disable approve
    // + show the needs-info banner from the cluster rows + detail pane (the
    // flat `suggested` array isn't what the Queue master list renders from).
    const live = state.actions
      .filter((a) => a.status === "suggested" || a.status === "approved")
      .map((a) => named({ ...a, missing_info: missingInfo(a) }));
    const clustersRaw = groupByTask(live, state.tasks);
    // Attach the daily-plan (tier / rank / why / entities) to each cluster and
    // order the Today list A→D then by rank. Unplanned clusters sink to the end.
    const plans = state.plans ?? {};
    const overrides = state.planOverrides ?? {};
    const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
    const clusters = clustersRaw
      .map((c) => {
        const key = c.task_id ?? (c.actions[0] ? `__ungrouped_${c.actions[0].id}` : undefined);
        const plan = key ? plans[key] : undefined;
        const ov = key ? overrides[key] : undefined;
        // A manual drag wins over the computed tier; keep the AI rank/why/entities.
        const effPlan = ov
          ? { ...(plan ?? { rank: 999, why: "" }), tier: ov, tierManual: true }
          : plan;
        return { ...c, plan: effPlan };
      })
      .sort((a, b) => {
        const ta = a.plan ? TIER_ORDER[a.plan.tier] ?? 8 : 9;
        const tb = b.plan ? TIER_ORDER[b.plan.tier] ?? 8 : 9;
        if (ta !== tb) return ta - tb;
        return (a.plan?.rank ?? 999) - (b.plan?.rank ?? 999);
      });
    const pendingTaskIds = new Set(
      suggested.map((a) => a.task_id ?? `__ungrouped_${a.id}`),
    );

    return {
      clusters,
      suggested,
      awaitingManual,
      done,
      skipped,
      sourceErrors: state.sourceErrors,
      gate: computeGate(state.outcomes),
      counts: {
        pending: suggested.length,
        tasks: pendingTaskIds.size,
        awaitingManual: awaitingManual.length,
      },
    };
  }

  // Projects screen (Microsoft To-Do style): every tracked project + the live
  // cards mapped to it (project_id), plus a MISC bucket for cards tied to no
  // project. Each card is a compact row (the detail still comes from /api/state).
  getProjects(): { projects: Array<Record<string, unknown>>; misc: Array<Record<string, unknown>> } {
    const projects = loadProjects(this.projectsDir());
    const resolveName = this.buildNameResolver();
    const live = loadState(this.opts.statePath).actions
      .filter((a) => a.status === "suggested" || a.status === "approved")
      .map((a) => ({ ...a, missing_info: missingInfo(a) }));
    const cardLite = (a: ActionItem & { missing_info: string[] }): Record<string, unknown> => ({
      id: a.id,
      action_type: a.action_type,
      status: a.status,
      headline: a.headline || (typeof a.params?.title === "string" ? a.params.title : "") || a.reason || "",
      summary: a.summary ?? "",
      next_actions: a.next_actions ?? [],
      sender_name: resolveName(a.context?.sender_handle) ?? a.context?.sender_handle ?? "",
      missing_info: a.missing_info,
    });
    const byProject = new Map<string, Array<Record<string, unknown>>>();
    const misc: Array<Record<string, unknown>> = [];
    for (const a of live) {
      const pid = a.project_id;
      if (pid && pid !== "MISC") {
        const arr = byProject.get(pid) ?? [];
        arr.push(cardLite(a));
        byProject.set(pid, arr);
      } else {
        misc.push(cardLite(a));
      }
    }
    const out = projects.map((p: Project) => ({
      id: p.id,
      company: p.company ?? "",
      name: p.name || p.id,
      goal: p.goal ?? "",
      status: p.status ?? "",
      current_state: p.current_state ?? "",
      needs: (p.needs ?? []).filter((n) => n.status === "gap" || n.status === "partial"),
      blockers: p.blockers ?? [],
      cards: byProject.get(p.id) ?? [],
    }));
    return { projects: out, misc };
  }

  // Rich persona data for the People screen: the raw v3 persona + a
  // pre-computed Core-Knowledge field list (value + provenance + evidence) +
  // that person's live queue items. Separate call so the Queue poll stays lean.
  // Head-photo cache: { personaKey: url }, populated by scripts/resolve-avatars.ts
  // (Slack users.info). Read-only + best-effort — absent file → initials avatars.
  private loadAvatars(): Record<string, string> {
    try {
      const raw = readFileSync(join(dirname(this.opts.statePath), "avatars.json"), "utf8");
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  getPeople(): Array<Record<string, unknown>> {
    const raw = loadRawPersonas(this.opts.personaDir);
    const avatars = this.loadAvatars();
    const live = loadState(this.opts.statePath).actions.filter(
      (a) => a.status === "suggested" || a.status === "approved",
    );
    // Scalar fields shown as Core-Knowledge cards (header/Voice/Threads/
    // Commitments are rendered from their own dedicated v3 sections).
    const FIELD_SPECS: Array<[string, string]> = [
      ["identity.role", "Role"],
      ["identity.org", "Org"],
      ["relationship_meta.decision_authority", "Decision authority"],
      ["communication.response_rhythm", "Response rhythm"],
      ["communication.active_hours", "Active hours"],
      ["communication.urgency_calibration", "Urgency"],
      ["behavior.reliability", "Reliability"],
      ["behavior.bad_news_style", "Bad-news style"],
      ["behavior.pet_peeves", "Pet peeves"],
      ["personal.family", "Family"],
      ["personal.notes", "Notes"],
      ["personal.interests", "Interests"],
    ];
    const get = (o: unknown, path: string): unknown =>
      path.split(".").reduce<unknown>((c, k) => (c && typeof c === "object" ? (c as Record<string, unknown>)[k] : undefined), o);
    return raw.map((p) => {
      const prov = p.provenance as Record<string, "manual" | "inferred"> | undefined;
      const ev = p.evidence as Record<string, string> | undefined;
      const fields = FIELD_SPECS.flatMap(([path, label]) => {
        let value = get(p, path);
        if (value == null || value === "") return [];
        if (Array.isArray(value)) value = value.join(" · ");
        return [{ label, value: String(value), provenance: provenanceFor(path, prov), evidence: evidenceFor(path, ev) ?? null }];
      });
      const handles = (p.handles as Record<string, string> | undefined) ?? {};
      const handleVals = Object.values(handles).filter(Boolean).map((h) => String(h).toLowerCase());
      const tasks = live
        .filter(
          (a) =>
            a.target?.personaKey === p.key ||
            handleVals.includes(String(a.context?.sender_handle ?? "").toLowerCase()),
        )
        .map((a) => ({
          id: a.id,
          action_type: a.action_type,
          status: a.status,
          title: (typeof a.params?.title === "string" && a.params.title) || a.draft || a.reason || "",
        }));
      const avatar = (typeof p.key === "string" && avatars[p.key]) || undefined;
      return { ...p, fields, tasks, avatar };
    });
  }

  // ─── mutations (each under the single-writer lock) ────────────────

  private withLock<T>(fn: (state: LoopState) => T): T {
    const stateDir = dirname(this.opts.statePath);
    if (!acquireLock(stateDir)) {
      throw new CockpitBusyError();
    }
    try {
      const state = loadState(this.opts.statePath);
      return fn(state);
    } finally {
      releaseLock(stateDir);
    }
  }

  private findOrThrow(state: LoopState, id: string): ActionItem {
    const a = state.actions.find((x) => x.id === id);
    if (!a) throw new CockpitNotFoundError(id);
    return a;
  }

  private replace(state: LoopState, updated: ActionItem): void {
    const idx = state.actions.findIndex((x) => x.id === updated.id);
    if (idx >= 0) state.actions[idx] = updated;
  }

  // P0 instrumentation: every cockpit decision lands in the append-only label
  // ledger with a REAL decided_at (the source state never recorded one) plus the
  // human's reason. Any edit diff accumulated on the card while it was suggested
  // rides along, so one label = one decision with its full edit history.
  // Never throws: a ledger hiccup must not block the user's decision (unlike the
  // removal paths, nothing is being destroyed here).
  private label(
    action: ActionItem,
    decision: LabelDecision,
    extra: { existence?: ExistenceVerdict; field_errors?: FieldError[]; note?: string } = {},
  ): void {
    try {
      const raw = (action.params as { _edit_diff?: unknown })._edit_diff;
      const edit_diff = Array.isArray(raw) ? (raw as EditDiffEntry[]) : undefined;
      appendLabel(
        labelsPathFor(this.opts.statePath),
        buildLabel({
          action,
          decision,
          decided_at: this.now(),
          ...(extra.existence ? { existence: extra.existence } : {}),
          ...(extra.field_errors && extra.field_errors.length ? { field_errors: extra.field_errors } : {}),
          ...(extra.note ? { note: extra.note } : {}),
          ...(edit_diff && edit_diff.length ? { edit_diff } : {}),
        }),
      );
    } catch {
      /* ledger unavailable — never block the human's decision */
    }
  }

  // Approve → execute. Returns the post-execution action + flags so the UI
  // can render the slide-out (sent), the awaiting-manual morph (gmail/
  // wechat), or the conflict state (calendar).
  async approve(id: string): Promise<ApproveResult> {
    const stateDir = dirname(this.opts.statePath);
    if (!acquireLock(stateDir)) throw new CockpitBusyError();
    try {
      let state = loadState(this.opts.statePath);
      const action = this.findOrThrow(state, id);
      // approveAction throws on missing-info — surfaced as 400 by the server.
      const approved = approveAction(action);
      this.replace(state, approved);
      saveState(this.opts.statePath, state); // persist approval before execute

      // persistClaim writes the executing marker mid-flight (crash-safe).
      const persistClaim = async (claimed: ActionItem): Promise<void> => {
        const s = loadState(this.opts.statePath);
        const idx = s.actions.findIndex((x) => x.id === claimed.id);
        if (idx >= 0) s.actions[idx] = claimed;
        saveState(this.opts.statePath, s);
      };

      let result: ExecuteResult;
      try {
        result = await this.opts.executor(approved, persistClaim);
      } catch (e) {
        // Execution failed AFTER we persisted "approved". Don't strand the
        // card as approved-with-no-side-effect (which shows a false "Draft
        // created" and blocks re-approval). Roll it back to suggested so the
        // user can retry — UNLESS a receipt was already written (the side
        // effect happened), in which case it stays as-is.
        const s = loadState(this.opts.statePath);
        const cur = s.actions.find((x) => x.id === id);
        if (cur && cur.status === "approved" && !hasReceipt(cur)) {
          const { execution_started_at: _started, ...cleanParams } = cur.params;
          const restored = restoreAction({ ...cur, params: cleanParams });
          this.replace(s, restored);
          saveState(this.opts.statePath, s);
        }
        throw e;
      }

      // Re-load (the claim write may have mutated on disk) and apply final.
      state = loadState(this.opts.statePath);
      if (result.conflicts && result.conflicts.length > 0) {
        // No event created — un-approve so the user can re-time + re-approve.
        const restored = restoreAction(approved);
        this.replace(state, restored);
        saveState(this.opts.statePath, state);
        return { ok: false, conflicts: result.conflicts, action: restored };
      }
      this.replace(state, result.action);
      saveState(this.opts.statePath, state);
      // Approving IS the confirmation signal. An awaiting-manual item is not
      // terminal yet — markSent/markDone labels it when the human finishes.
      if (result.action.status === "executed") {
        this.label(result.action, "executed", { existence: "confirmed" });
      }
      return {
        ok: true,
        action: result.action,
        awaitingManual: result.awaitingManual,
        receipt: result.receipt,
      };
    } finally {
      releaseLock(stateDir);
    }
  }

  // Edit a suggested action's draft and/or params, flag it edited (feeds
  // the validation gate's edit-vs-clean signal). Stays suggested.
  edit(id: string, patch: { draft?: string; params?: Record<string, unknown> }): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      if (action.status !== "suggested")
        throw new CockpitBadStateError(id, action.status, "edit requires suggested");
      // P0: capture WHAT the human changed, not just that they changed something.
      // The old `_edited: true` flag said an edit happened but threw away the
      // content — which is why only 1 of 365 actions had any edit signal. The
      // diff accumulates on the card and is attached to the decision label.
      const prior = (action.params as { _edit_diff?: unknown })._edit_diff;
      const diff: EditDiffEntry[] = Array.isArray(prior) ? [...(prior as EditDiffEntry[])] : [];
      if (patch.draft !== undefined && patch.draft !== action.draft) {
        diff.push({ field: "draft", before: action.draft ?? null, after: patch.draft });
      }
      for (const [k, after] of Object.entries(patch.params ?? {})) {
        const before = (action.params as Record<string, unknown>)[k];
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          diff.push({ field: `params.${k}`, before: before ?? null, after });
        }
      }
      const updated: ActionItem = {
        ...action,
        ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
        params: {
          ...action.params,
          ...(patch.params ?? {}),
          _edited: true,
          ...(diff.length ? { _edit_diff: diff } : {}),
        },
      };
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      return updated;
    });
  }

  // reason/field_errors are the P0 typed-skip signal. `deferred` means "the card
  // is right, just not today" and is excluded from the precision denominator —
  // counting a deferral as a false positive would understate real precision.
  skip(
    id: string,
    reason?: { existence?: ExistenceVerdict; field_errors?: FieldError[]; note?: string },
  ): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      const updated = rejectAction(action); // throws if not suggested
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.label(updated, "rejected", {
        existence: reason?.existence,
        field_errors: reason?.field_errors,
        note: reason?.note,
      });
      return updated;
    });
  }

  restore(id: string): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      const updated = restoreAction(action); // throws if has receipt / wrong status
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      return updated;
    });
  }

  // Mark an awaiting-manual item (Gmail draft the user sent, or a WeChat
  // paste) as done — writes the receipt + executed. The receipt ref comes
  // from the UI (a Gmail message link or "manual").
  // Manual tier override from a drag in the Today list. tier null clears it (back
  // to the AI ranking). Keyed by the task unit key (task_id / __ungrouped_<id>).
  setTier(key: string, tier: "A" | "B" | "C" | "D" | null): { key: string; tier: string | null } {
    return this.withLock((state) => {
      const ov = state.planOverrides ?? (state.planOverrides = {});
      if (tier) ov[key] = tier;
      else delete ov[key];
      saveState(this.opts.statePath, state);
      return { key, tier };
    });
  }

  // Today resolution plan: tick off a Me·reminder (task/ignore) as done. No
  // send, no missing-info gate — a local receipt + executed.
  markDone(id: string): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      const receipt: ExecutionReceipt = { kind: "local", ref: "manual-done", at: this.now() };
      const updated = markDone(withReceipt(action, receipt));
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.label(updated, "executed", { existence: "confirmed" });
      return updated;
    });
  }

  markSent(id: string, ref: string = "manual"): ActionItem {
    return this.withLock((state) => {
      const action = this.findOrThrow(state, id);
      if (action.status !== "approved")
        throw new CockpitBadStateError(id, action.status, "markSent requires approved");
      const receipt: ExecutionReceipt = { kind: "sent", ref, at: this.now() };
      const updated = markExecuted(withReceipt(action, receipt));
      this.replace(state, updated);
      saveState(this.opts.statePath, state);
      this.label(updated, "executed", { existence: "confirmed" });
      return updated;
    });
  }

  // Auto-execute the high-confidence task/ignore items (confidence ≥ 0.9,
  // no missing info). The cockpit calls this on load so the queue shows
  // only what genuinely needs a human. Returns the count auto-handled.
  async flushAutoExecute(): Promise<number> {
    const stateDir = dirname(this.opts.statePath);
    if (!acquireLock(stateDir)) throw new CockpitBusyError();
    try {
      const state = loadState(this.opts.statePath);
      const candidates = state.actions.filter((a) => canAutoExecute(a));
      let n = 0;
      for (const cand of candidates) {
        const approved = approveAction(cand);
        const result = await this.opts.executor(approved, async () => {});
        this.replace(state, result.action);
        n++;
      }
      if (n > 0) saveState(this.opts.statePath, state);
      return n;
    } finally {
      releaseLock(stateDir);
    }
  }
}

export interface ApproveResult {
  ok: boolean;
  action: ActionItem;
  awaitingManual?: boolean;
  receipt?: ExecutionReceipt;
  conflicts?: ExecuteResult["conflicts"];
}

// ─── typed errors the server maps to HTTP statuses ─────────────────────

export class CockpitNotFoundError extends Error {
  constructor(public id: string) {
    super(`action not found: ${id}`);
    this.name = "CockpitNotFoundError";
  }
}
export class CockpitBusyError extends Error {
  constructor() {
    super("state is locked by another writer — retry");
    this.name = "CockpitBusyError";
  }
}
export class CockpitBadStateError extends Error {
  constructor(public id: string, public status: string, detail: string) {
    super(`${detail} (action ${id} is "${status}")`);
    this.name = "CockpitBadStateError";
  }
}
