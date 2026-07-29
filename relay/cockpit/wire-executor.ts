// Wires the cockpit's approve flow to the real Direct-API executors.
// Lives apart from api.ts so the API core stays Keychain-free and
// unit-testable; this module is the prod adapter that builds the
// Slack / Gmail / Calendar clients from Keychain and adapts
// executeAction into the CockpitExecutor shape (action + persistClaim).
//
// Clients are built lazily + cached: the first approve spins up the
// Slack client + per-mailbox Gmail/Calendar clients; later approves
// reuse them. OAuth refresh happens inside the Gmail/Calendar clients
// via google-oauth, so a long-lived cockpit keeps working past token
// expiry without re-wiring.

import { buildRawMimeMessage } from "../sources/gmail-direct.js";
import { createSlackClientFromKeychain } from "../io/slack-api.js";
import { GmailClient } from "../io/gmail-api.js";
import { CalendarClient } from "../io/calendar-api.js";
import { KNOWN_MAILBOXES } from "../io/google-oauth.js";
import { executeAction, type ExecuteDeps } from "../proc/execute.js";
import type { CockpitExecutor } from "./api.js";
import type { ActionItem } from "../core/action-item.js";

// Lazy singletons — built on first use, reused after.
let depsPromise: Promise<Omit<ExecuteDeps, "now" | "persistClaim">> | null = null;

async function buildDeps(): Promise<Omit<ExecuteDeps, "now" | "persistClaim">> {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const slack = await createSlackClientFromKeychain();
    const gmail: Record<string, GmailClient> = {};
    const calendar: Record<string, CalendarClient> = {};
    for (const email of KNOWN_MAILBOXES) {
      gmail[email] = new GmailClient({ email });
      calendar[email] = new CalendarClient({ email });
    }
    return { slack, gmail, calendar };
  })();
  return depsPromise;
}

export function createWiredExecutor(now: () => string = () => new Date().toISOString()): CockpitExecutor {
  return async (action: ActionItem, persistClaim) => {
    const base = await buildDeps();
    // Gmail reply/relay/forward need a raw MIME body. The scan/LLM path
    // should have populated params.raw_mime; if it didn't but we have a
    // draft + recipient, assemble one here so the executor has something
    // to draft. (Belt-and-suspenders — the LLM path is expected to set it.)
    const prepared = ensureGmailRaw(action);
    return executeAction(prepared, { ...base, now, persistClaim });
  };
}

// If a Gmail-targeted reply/relay/forward lacks params.raw_mime but has a
// draft + the bits to build one, assemble it. Mailbox + recipient + subject
// come from params/context the scan persisted.
function ensureGmailRaw(action: ActionItem): ActionItem {
  if (action.target?.platform !== "gmail") return action;
  if (typeof action.params.raw_mime === "string") return action;
  const draft = action.draft;
  const to = typeof action.params.to === "string" ? action.params.to : action.context?.sender_handle;
  const from = typeof action.params.mailbox === "string" ? action.params.mailbox : undefined;
  const subject =
    typeof action.params.subject === "string" ? action.params.subject : "Re: (no subject)";
  if (typeof draft !== "string" || !to || !from) return action; // executor will error clearly
  const raw = buildRawMimeMessage({
    from,
    to,
    subject,
    body: draft,
    inReplyTo: typeof action.params.in_reply_to === "string" ? action.params.in_reply_to : undefined,
  });
  return { ...action, params: { ...action.params, raw_mime: raw } };
}
