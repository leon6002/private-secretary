// Connections screen — React port of legacy public/js/connections.js, which
// remains the behavioral reference: one status card per source (Slack, Gmail,
// Calendar, WeChat) driven by /api/state's sourceErrors, plus a per-mailbox
// Reconnect button when a Gmail OAuth refresh token dies.
//
// The card copy, dot colors, and layout are verbatim legacy. Two intentional
// differences from the vanilla version, both behavior-preserving:
// - no escapeHtml anywhere — React escapes interpolated text by itself;
// - reauth button state is React state instead of DOM mutation, but follows
//   the same lifecycle: disabled + "Opening browser…" while in flight, and on
//   SUCCESS it stays that way until the next poll drops the sourceError (the
//   legacy code likewise only re-enabled the button on failure).
import { useState } from "react";
import { apiPost } from "../lib/api";
import { cn } from "../lib/cn";
import { toast } from "../lib/toast";
import { useCockpitState, type SourceError } from "../lib/useCockpitState";

type Dot = "green" | "red" | "gray";
const DOT_CLS: Record<Dot, string> = {
  green: "bg-emerald-500",
  red: "bg-error",
  // Legacy gray was slate-300, which reads near-white against the dark
  // surface; slate-600 keeps the same muted "manual / not connected"
  // meaning in dark mode without looking like a healthy green's sibling.
  gray: "bg-slate-300 dark:bg-slate-600",
};

// Parse the failing Gmail mailboxes out of the gmail:direct sourceError
// message (shape: "mailbox=<email>: <err>; mailbox=<email>: <err>") — the
// same regex the server side uses in relay/cockpit/reauth.ts. Returns the
// unique emails so the card can offer one Reconnect button per dead mailbox.
function failingGmailMailboxes(msg: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (msg ?? "").matchAll(/mailbox=([^\s:]+@[^\s:]+)/g)) out.add(m[1]!);
  return [...out];
}

function StatusCard({
  name,
  detail,
  dot,
  sub,
  extra,
}: {
  name: string;
  detail: string;
  dot: Dot;
  sub?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="bg-surface border border-outline rounded p-4 flex items-start gap-2">
      <span className={cn("w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0", DOT_CLS[dot])} />
      <div className="flex-1">
        <div className="text-body-medium text-on-surface">{name}</div>
        <div className="text-label-sm text-on-surface-variant">{detail}</div>
        {sub && <div className="text-label-sm text-on-surface-variant opacity-70 mt-0.5">{sub}</div>}
        {extra}
      </div>
    </div>
  );
}

export default function ConnectionsScreen() {
  const { state } = useCockpitState();
  const [pendingMailbox, setPendingMailbox] = useState<string | null>(null);

  // Legacy default: no state yet (first poll in flight or failing) renders
  // the same as "no source errors" — cards green/gray, no alarm.
  const errs: Record<string, SourceError> = state?.sourceErrors ?? {};
  const slackErr = errs["slack:direct"];
  const gmailErr = errs["gmail:direct"];

  // Clicking Reconnect spawns the OAuth consent flow server-side (it opens
  // the browser); the daemon self-heals on its next tick and the next poll
  // clears the error — which is also what removes this button.
  async function reauthGmail(mailbox: string) {
    setPendingMailbox(mailbox);
    try {
      const r = await apiPost<{ detail?: string }>("/api/connections/gmail/reauth", { mailbox });
      toast(r.detail || `Reconnecting ${mailbox}…`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      setPendingMailbox(null);
    }
  }

  const gmailReauth = gmailErr ? (
    <div className="mt-2 flex flex-col gap-1 items-start">
      {failingGmailMailboxes(gmailErr.message).map((mb) => (
        <button
          key={mb}
          type="button"
          disabled={pendingMailbox === mb}
          onClick={() => void reauthGmail(mb)}
          className={cn(
            "text-label-sm text-primary border border-primary/40 bg-primary/5 rounded px-2 py-1",
            "hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:pointer-events-none",
          )}
        >
          {pendingMailbox === mb ? `Opening browser for ${mb}…` : `Reconnect ${mb}`}
        </button>
      ))}
    </div>
  ) : undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-[60px] bg-surface border-b border-outline flex items-center px-6 flex-shrink-0">
        <h1 className="text-headline">Connections</h1>
      </header>
      <div className="flex-1 bg-background overflow-y-auto p-6 flex justify-center">
        <div className="w-full max-w-[640px] flex flex-col gap-2">
          <StatusCard
            name="Slack · Taiv"
            detail={slackErr ? "token issue — cursor frozen, nothing lost" : "connected · direct API · IMs + group DMs"}
            dot={slackErr ? "red" : "green"}
            sub="read · send (after approval)"
          />
          <StatusCard
            name="Gmail · 4 mailboxes"
            detail={gmailErr ? "token expired — cursor frozen, nothing lost" : "connected · delta via historyId"}
            dot={gmailErr ? "red" : "green"}
            sub="sending is draft-only by design — you press Send in Gmail"
            extra={gmailReauth}
          />
          <StatusCard
            name="Google Calendar"
            detail="connected · conflict-check before booking"
            dot="green"
            sub="read · create (after approval)"
          />
          <StatusCard name="WeChat" detail="manual — read via local decrypt, send by paste" dot="gray" />
          <div className="text-label-sm text-on-surface-variant mt-4 leading-relaxed">
            Nothing is ever sent without your approval.<br />
            Behavior rules are fixed by design — there are no toggles.<br />
            Detection runs continuously; analysis happens only when something arrives.
          </div>
        </div>
      </div>
    </div>
  );
}
