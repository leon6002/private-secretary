// Action Item: the engine's single output type. A relay is just one action_type,
// executed via RelayExecutor after approval like every other action.
//
// Status flow (no-double-execute is a mandatory regression guarantee):
//
//   suggested ──approve──▶ approved ──markExecuted──▶ executed   (terminal)
//       │                     ▲
//       └──skip──▶ rejected   │ wechat reply/relay/forward wait at "approved"
//                  (terminal) │ for manual paste; auto-send platforms execute
//                             │ immediately after approve, then markExecuted

import { AUTO_SEND_PLATFORMS, type Attachment, type Platform } from "./types.js";

// Scan interval: a single constant. Override with the SCAN_INTERVAL_MINUTES env var
// at the call site if needed. No config system (V1 hard decision).
export const DEFAULT_SCAN_INTERVAL_MINUTES = 30;

export type ActionType =
  | "reply"
  | "relay"
  | "forward"
  | "calendar"
  | "task"
  | "ignore";
// Every action — reply included — is human-in-the-loop: nothing executes until the
// user approves. After approval it executes (sends/creates). The approval gate is
// the guarantee, not "never send".
export type ActionStatus = "suggested" | "approved" | "executed" | "rejected";

// Proof an executor's platform side-effect already happened. Written before the
// terminal transition; on retry, a present receipt means skip the API call and go
// straight to terminal — so replaying an approved action never double-sends.
export interface ExecutionReceipt {
  kind: "sent" | "calendar_event" | "local";
  ref: string; // message_link / event_id / "local"
  at: string; // ISO timestamp
}

export interface ActionTarget {
  personaKey?: string | null;
  platform?: Platform | null;
  attendees?: string[];
}

// Snapshot of everything the cockpit needs to render an action's detail pane
// WITHOUT MCP access (Phase 2, T2). The scan persists this when it creates the
// row — once written it is the offline source of truth, because the cockpit
// cannot re-fetch the original from Slack/Gmail. evidence_consulted records the
// R5 full-context pull (thread/ticket/page ids + permalinks) so the card can
// show "what I read before drafting".
export interface ActionContext {
  original_message?: string;
  sender_handle?: string;
  // Slack display name resolved at scan time (relay/io/slack-users.ts). The
  // cockpit's fallback order is persona name → this → raw sender_handle.
  sender_name?: string;
  sent_at?: string; // ISO
  permalink?: string;
  attachments?: Attachment[];
  evidence_consulted?: string[];
  // Thread locator for the Stage-2 refresh re-read. Gmail needs it (the
  // card's source_message_id is the message id, not the threadId, which is
  // otherwise unrecoverable); Slack/WeChat derive their locator from the
  // source id / sender_handle so they don't depend on this. Stored as the raw
  // platform handle (Gmail: threadId).
  thread_ref?: string;
}

export interface ActionItem {
  id: string;
  source_message_id: string;
  action_type: ActionType;
  target: ActionTarget;
  reason: string;
  confidence: number; // 0–1
  params: Record<string, unknown>; // per action_type, see missingInfo()
  draft?: string;
  status: ActionStatus;
  created_at: string; // ISO timestamp of the scan round
  // Phase 2 (T1): groups cross-round, cross-sender actions into one task (e.g.
  // the Chicago trip spans Zack + Kevin). Assigned by the skill at round-commit;
  // the registry of {task_id: {title}} lives in loop-state. Absent = ungrouped.
  task_id?: string;
  context?: ActionContext; // T2: offline detail-pane snapshot
  // Card-presentation fields (LLM-produced, optional, never gate approval):
  // headline = short "what is this about" title; summary = 1–2 sentence digest
  // of the message(s); next_actions = 1–3 concrete next-step bullets generated
  // from the persona + thread context. Absent on legacy rows → the cockpit
  // falls back to reason / original_message.
  headline?: string;
  summary?: string;
  next_actions?: string[];
  // The tracked project (id) this card advances, e.g. "OUS-1", or "MISC" when it
  // belongs to no tracked project. Set by the LLM from the project RAG; the
  // cockpit resolves it to a name + groups the Projects screen by it.
  project_id?: string;
}

const ACTION_TYPES: ReadonlySet<string> = new Set([
  "reply",
  "relay",
  "forward",
  "calendar",
  "task",
  "ignore",
]);
const STATUSES: ReadonlySet<string> = new Set([
  "suggested",
  "approved",
  "executed",
  "rejected",
]);

// Missing required info per action_type. A non-empty result blocks approval —
// the engine is not allowed to guess (spec hard rule).
export function missingInfo(a: ActionItem): string[] {
  const missing: string[] = [];
  const p = a.params ?? {};
  const needRecipient = (): void => {
    if (!a.target?.personaKey) missing.push("target.personaKey");
    if (!a.target?.platform) missing.push("target.platform");
  };
  switch (a.action_type) {
    case "reply": {
      // A reply goes back to the SENDER — the recipient is never ambiguous,
      // so NO persona is required (the executor sends to context.sender_handle
      // / the originating channel, not target.personaKey). Only flag a missing
      // recipient if we have no way to address it at all.
      if (!a.target?.platform) missing.push("target.platform");
      if (typeof a.draft !== "string" || a.draft.trim() === "") missing.push("draft");
      const hasRecipient =
        !!a.context?.sender_handle ||
        (typeof p.to === "string" && p.to !== "") ||
        !!a.target?.personaKey;
      if (!hasRecipient) missing.push("target.personaKey");
      break;
    }
    case "relay":
      needRecipient();
      if (typeof a.draft !== "string" || a.draft.trim() === "") missing.push("draft");
      break;
    case "forward":
      needRecipient();
      break;
    case "calendar":
      for (const k of ["title", "start", "end"] as const) {
        if (typeof p[k] !== "string" || p[k] === "") missing.push(`params.${k}`);
      }
      // attendees are OPTIONAL: an auto-created event is a block on Leo's own
      // calendar (huizhezheng@gmail.com). A meeting agreed over WeChat has no
      // attendee emails — the people/place go in the title/description instead.
      // Requiring attendees would make every such event un-approvable.
      break;
    case "task":
      if (typeof p.title !== "string" || p.title === "") missing.push("params.title");
      break;
    case "ignore":
      if (typeof p.category !== "string" || p.category === "")
        missing.push("params.category");
      break;
  }
  return missing;
}

// Supersede exemption (fix/supersede-keep-calendar). Cross-tick supersede kills
// ALL still-suggested same-sender cards when a fresh draft lands — right for
// task/reply (one chatty contact = one evolving card, no floods), but a sender
// switching TOPICS would silently drop a pending meeting ("明天10点见客户"
// killed by a later unrelated message). A suggested CALENDAR card with a
// concrete start time is a commitment, not an evolving draft — exempt it.
// A calendar WITHOUT params.start still supersedes: it's half-baked and
// missing-info anyway. Trade-off: if the meeting time CHANGES in the thread,
// the old-time card now survives alongside the new one — the user picks the
// right one and skips the other. Acceptable: human decides, skip is cheap,
// and it beats silently losing the event.
export function isSupersedeExempt(a: ActionItem): boolean {
  return (
    a.action_type === "calendar" &&
    typeof a.params?.start === "string" &&
    a.params.start !== ""
  );
}

// Already-booked check (draft-commit + refresh-commit in scan-loop). A fresh
// suggested calendar whose task_id OR exact start matches an EXECUTED calendar
// is a duplicate waiting to double-book — the event already exists. Refresh
// used to skip this check entirely (phase 3 had it, phase 5 didn't), which is
// how one meeting ended up approved into N real events.
export function isCalendarAlreadyBooked(a: ActionItem, existing: ActionItem[]): boolean {
  if (a.action_type !== "calendar") return false;
  const start = typeof a.params?.start === "string" ? a.params.start : undefined;
  return existing.some(
    (e) =>
      e.action_type === "calendar" &&
      e.status === "executed" &&
      ((a.task_id && e.task_id === a.task_id) ||
        (start !== undefined && e.params?.start === start)),
  );
}

export type ValidationResult =
  | { ok: true; item: ActionItem }
  | { ok: false; errors: string[] };

// Structural validation of an LLM-produced item. Missing per-type params are NOT
// structural errors (they become missing-info and block approval instead) — but
// malformed shape, unknown enums, or out-of-range confidence are rejected outright
// so junk never enters the queue.
export function validateActionItem(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["not an object"] };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.action_type !== "string" || !ACTION_TYPES.has(o.action_type))
    errors.push(`action_type must be one of ${[...ACTION_TYPES].join("|")}`);
  if (typeof o.source_message_id !== "string" || o.source_message_id.trim() === "")
    errors.push("source_message_id is required");
  if (typeof o.reason !== "string" || o.reason.trim() === "")
    errors.push("reason is required");
  if (typeof o.confidence !== "number" || o.confidence < 0 || o.confidence > 1)
    errors.push("confidence must be a number in [0,1]");
  if (o.status !== undefined && (typeof o.status !== "string" || !STATUSES.has(o.status)))
    errors.push(`status must be one of ${[...STATUSES].join("|")}`);
  if (o.target !== undefined && (typeof o.target !== "object" || o.target === null))
    errors.push("target must be an object");
  if (o.params !== undefined && (typeof o.params !== "object" || o.params === null))
    errors.push("params must be an object");
  if (o.draft !== undefined && typeof o.draft !== "string")
    errors.push("draft must be a string");
  if (o.task_id !== undefined && (typeof o.task_id !== "string" || o.task_id.trim() === ""))
    errors.push("task_id must be a non-empty string when present");
  if (o.context !== undefined && (typeof o.context !== "object" || o.context === null))
    errors.push("context must be an object");
  if (o.headline !== undefined && typeof o.headline !== "string")
    errors.push("headline must be a string");
  if (o.summary !== undefined && typeof o.summary !== "string")
    errors.push("summary must be a string");
  if (o.next_actions !== undefined && !Array.isArray(o.next_actions))
    errors.push("next_actions must be an array");
  if (o.project_id !== undefined && typeof o.project_id !== "string")
    errors.push("project_id must be a string");
  if (errors.length) return { ok: false, errors };

  const item: ActionItem = {
    id: typeof o.id === "string" && o.id !== "" ? o.id : "",
    source_message_id: o.source_message_id as string,
    action_type: o.action_type as ActionType,
    target: (o.target ?? {}) as ActionTarget,
    reason: o.reason as string,
    confidence: o.confidence as number,
    params: (o.params ?? {}) as Record<string, unknown>,
    draft: o.draft as string | undefined,
    status: (o.status as ActionStatus | undefined) ?? "suggested",
    created_at: typeof o.created_at === "string" ? o.created_at : "",
  };
  if (typeof o.task_id === "string" && o.task_id.trim() !== "") item.task_id = o.task_id;
  if (typeof o.context === "object" && o.context !== null)
    item.context = o.context as ActionContext;
  if (typeof o.headline === "string" && o.headline.trim() !== "") item.headline = o.headline;
  if (typeof o.summary === "string" && o.summary.trim() !== "") item.summary = o.summary;
  if (Array.isArray(o.next_actions)) {
    const xs = o.next_actions.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (xs.length) item.next_actions = xs;
  }
  if (typeof o.project_id === "string" && o.project_id.trim() !== "") item.project_id = o.project_id.trim();
  return { ok: true, item };
}

export class InvalidActionTransition extends Error {
  constructor(action: string, from: string, detail?: string) {
    super(
      `Invalid action transition: ${action} from "${from}"${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "InvalidActionTransition";
  }
}

// True when execution cannot be automated: a send to a platform without an official
// send API (WeChat personal). These stay at "approved" until the user marks them done.
export function requiresManualExecution(a: ActionItem): boolean {
  if (
    a.action_type !== "reply" &&
    a.action_type !== "relay" &&
    a.action_type !== "forward"
  )
    return false;
  const platform = a.target?.platform;
  return platform != null && !AUTO_SEND_PLATFORMS.has(platform);
}

export function approveAction(a: ActionItem): ActionItem {
  if (a.status !== "suggested") throw new InvalidActionTransition("approve", a.status);
  const missing = missingInfo(a);
  if (missing.length > 0)
    throw new InvalidActionTransition(
      "approve",
      a.status,
      `missing info: ${missing.join(", ")}`,
    );
  return { ...a, status: "approved" };
}

export function rejectAction(a: ActionItem): ActionItem {
  if (a.status !== "suggested") throw new InvalidActionTransition("skip", a.status);
  return { ...a, status: "rejected" };
}

export function markExecuted(a: ActionItem): ActionItem {
  if (a.status !== "approved")
    throw new InvalidActionTransition("markExecuted", a.status);
  return { ...a, status: "executed" };
}

// Manual "mark done" from the Today resolution plan: the user asserts a
// no-side-effect reminder is handled. Only task/ignore (nothing is sent), and it
// bypasses the missing-info gate on purpose — completing a reminder must not
// require the LLM to have filled params. reply/relay/forward/calendar are NOT
// eligible (those complete by sending/booking or skipping, never a silent tick).
export function markDone(a: ActionItem): ActionItem {
  if (a.status !== "suggested" && a.status !== "approved")
    throw new InvalidActionTransition("markDone", a.status);
  if (a.action_type !== "task" && a.action_type !== "ignore")
    throw new InvalidActionTransition("markDone", a.status, "only task/ignore can be marked done");
  return { ...a, status: "executed" };
}

// Phase 2 (T6): un-approve / un-skip / un-do back to suggested, so the
// cockpit's [Restore] works from both the skipped list and the completed
// list. Only legal when NO real external side effect happened:
//   · receipt.kind "sent" / "calendar_event" → the message went out / the
//     event was created. It can never be un-sent, so restoring would lie and
//     risks a double-send on re-approval — the item stays terminal.
//   · receipt.kind "local" (auto-ticked / manually-done task·ignore) or no
//     receipt at all → nothing left the machine, so undo is safe.
// An executed item is therefore restorable ONLY in the local/no-receipt case;
// an executed item with a real side effect stays terminal forever.
export function restoreAction(a: ActionItem): ActionItem {
  if (a.status !== "rejected" && a.status !== "approved" && a.status !== "executed")
    throw new InvalidActionTransition("restore", a.status);
  const receipt = a.params?.execution_receipt as ExecutionReceipt | undefined;
  if (receipt && receipt.kind !== "local")
    throw new InvalidActionTransition(
      "restore",
      a.status,
      `already has a ${receipt.kind} receipt (real side effect happened) — cannot restore`,
    );
  return { ...a, status: "suggested" };
}

// T4 — crash-safe send. The receipt can only be written AFTER the platform call
// returns (it carries the message link / event id), so a crash between "MCP
// succeeded" and "receipt persisted" would otherwise re-send on retry. markExecuting
// writes a durable `execution_started_at` BEFORE the side effect. On retry the skill
// sees executing-but-no-receipt and MUST verify on the platform (did the message
// actually go out?) before re-sending — never blind-resend. Status stays "approved":
// no new state, just a claim flag.
export function markExecuting(a: ActionItem, at: string): ActionItem {
  if (a.status !== "approved")
    throw new InvalidActionTransition("markExecuting", a.status);
  return { ...a, params: { ...a.params, execution_started_at: at } };
}

export function isExecuting(a: ActionItem): boolean {
  return a.params?.execution_started_at != null && !hasReceipt(a);
}

// Idempotency: record/inspect the platform side-effect receipt in params.
export function hasReceipt(a: ActionItem): boolean {
  return a.params?.execution_receipt != null;
}

export function withReceipt(a: ActionItem, receipt: ExecutionReceipt): ActionItem {
  return { ...a, params: { ...a.params, execution_receipt: receipt } };
}
