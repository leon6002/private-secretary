// A SAFE executor for demos / QA: runs the real executeAction logic
// (status transitions, calendar conflict-check, MIME assembly, crash-safe
// persistClaim) against STUB platform clients, so approving a card in the
// cockpit exercises the full triage flow with NO real Slack send / Gmail
// draft / Calendar write. Use when pointing the cockpit at a copy of real
// state to review drafted cards without risk of contacting anyone.
//
// Mirror of wire-executor.ts; the only difference is the injected clients.

import { executeAction, type ExecuteDeps } from "../proc/execute.js";
import { buildRawMimeMessage } from "../sources/gmail-direct.js";
import { KNOWN_MAILBOXES } from "../io/google-oauth.js";
import type { CockpitExecutor } from "./api.js";
import type { ActionItem } from "../core/action-item.js";

// Stub senders: no network. They return plausible refs so receipts look
// real in the UI, and an empty calendar so conflict-check always clears.
function stubDeps(now: () => string): Omit<ExecuteDeps, "persistClaim"> {
  const gmail = Object.fromEntries(
    KNOWN_MAILBOXES.map((email) => [
      email,
      { createDraft: async () => ({ id: "DRY-RUN-DRAFT" }) },
    ]),
  );
  const calendar = Object.fromEntries(
    KNOWN_MAILBOXES.map((email) => [
      email,
      {
        listAllEvents: async () => [],
        insertEvent: async ({ event }: { event: import("../io/calendar-api.js").CalendarEvent }) => ({
          ...event,
          id: "DRY-RUN-EVENT",
        }),
      },
    ]),
  );
  return {
    slack: {
      postMessage: async ({ channel }: { channel: string }) => ({ ts: "DRY-RUN", channel }),
      getPermalink: async () => "https://dry-run.local/no-message-sent",
    },
    gmail,
    calendar,
    now,
  };
}

export function createDryExecutor(
  now: () => string = () => new Date().toISOString(),
): CockpitExecutor {
  const base = stubDeps(now);
  return async (action: ActionItem, persistClaim) => {
    const prepared = ensureGmailRaw(action);
    return executeAction(prepared, { ...base, persistClaim });
  };
}

// Same belt-and-suspenders MIME assembly as wire-executor, so a Gmail
// reply/relay card transitions correctly in the dry path too.
function ensureGmailRaw(action: ActionItem): ActionItem {
  if (action.target?.platform !== "gmail") return action;
  if (typeof action.params.raw_mime === "string") return action;
  const draft = action.draft;
  const to = typeof action.params.to === "string" ? action.params.to : action.context?.sender_handle;
  const from = typeof action.params.mailbox === "string" ? action.params.mailbox : undefined;
  const subject = typeof action.params.subject === "string" ? action.params.subject : "Re: (no subject)";
  if (typeof draft !== "string" || !to || !from) return action;
  const raw = buildRawMimeMessage({
    from,
    to,
    subject,
    body: draft,
    inReplyTo: typeof action.params.in_reply_to === "string" ? action.params.in_reply_to : undefined,
  });
  return { ...action, params: { ...action.params, raw_mime: raw } };
}
