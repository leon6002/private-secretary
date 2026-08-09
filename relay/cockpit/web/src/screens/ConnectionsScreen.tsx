// Connections — one row per connector, not a stack of cards.
//
// DESIGN.md is explicit that cards exist ONLY where the card is the
// interaction unit (approval cards) and that reference data uses lists or
// tables. Connection status is reference data, so the card wall this screen
// used to be was off-system; a real <table> with a Status column is the
// correction, not a new style.
//
// The three states a connector can be in are what the layout has to carry:
// connected (with the workspace/account it is connected AS), needs attention
// (token issue — one action per failing account), and not automated (WeChat,
// which has no API to connect to). Filters exist because that middle state is
// the one worth isolating when something breaks.
//
// No new motion: DESIGN.md allows exactly two product-wide motions and neither
// is here. Colour transitions on hover only, matching Tabs and the buttons.
import { useCallback, useEffect, useMemo, useState } from "react";
import Tabs from "../components/Tabs";
import { apiGet, apiPost } from "../lib/api";
import { cn } from "../lib/cn";
import { toast } from "../lib/toast";
import { useCockpitState, type SourceError } from "../lib/useCockpitState";

interface SlackConnection {
  account: string;
  kind: "none" | "legacy" | "pkce";
  connected: boolean;
  team?: string;
  /** Access-token expiry. Machinery — never surfaced; see reconnectBy. */
  expiresAt: number;
  /** When re-consent becomes necessary (refresh window), 0 if never. */
  reconnectBy: number;
  detail: string;
}

// Warn a week out from the re-consent deadline. The deadline itself moves
// forward on every refresh, so a running daemon never reaches it — this only
// fires for a machine that has been off, which is exactly when a week of
// notice is useful.
const RECONNECT_WARN_MS = 7 * 24 * 60 * 60 * 1000;

type RowState = "ok" | "attention" | "manual";

const DOT_CLS: Record<RowState, string> = {
  ok: "bg-emerald-500",
  attention: "bg-error",
  // Legacy gray was slate-300, which reads near-white against the dark
  // surface; slate-600 keeps the same muted "manual / not connected"
  // meaning in dark mode without looking like a healthy green's sibling.
  manual: "bg-slate-300 dark:bg-slate-600",
};

interface ConnectorRow {
  id: string;
  name: string;
  /** Who/what it is connected as — the second line under the name. */
  identity?: string;
  /** What the connection is allowed to do. */
  access: string;
  state: RowState;
  status: string;
  actions?: React.ReactNode;
}

// Parse the failing Gmail mailboxes out of the gmail:direct sourceError
// message (shape: "mailbox=<email>: <err>; mailbox=<email>: <err>") — the
// same regex the server side uses in relay/cockpit/reauth.ts. Returns the
// unique emails so the row can offer one Reconnect button per dead mailbox.
function failingGmailMailboxes(msg: string | undefined): string[] {
  const out = new Set<string>();
  for (const m of (msg ?? "").matchAll(/mailbox=([^\s:]+@[^\s:]+)/g)) out.add(m[1]!);
  return [...out];
}

function slackRow(
  conn: SlackConnection | null,
  hasError: boolean,
): Pick<ConnectorRow, "identity" | "access" | "state" | "status"> {
  const access = "read · send after approval";
  if (hasError) {
    return {
      identity: conn?.account,
      access,
      state: "attention",
      status: "token issue — cursor frozen, nothing lost",
    };
  }
  // Anything that is not a kind we recognise counts as not connected. Falling
  // through to the connected branch would render an undefined status.
  if (!conn || (conn.kind !== "legacy" && conn.kind !== "pkce")) {
    return { access, state: "manual", status: "not connected" };
  }
  if (conn.kind === "legacy") {
    return {
      identity: conn.account,
      access,
      state: "ok",
      status: "connected · legacy token",
    };
  }
  // Deliberately NOT conn.expiresAt: that is the ~12h access token, which the
  // runtime refreshes silently. Warning on it would paint this row red
  // permanently — alarm theater for normal machinery.
  const left = conn.reconnectBy - Date.now();
  if (conn.reconnectBy && left <= 0) {
    return {
      identity: conn.account,
      access,
      state: "attention",
      status: "sign-in expired — reconnect to resume",
    };
  }
  if (conn.reconnectBy && left < RECONNECT_WARN_MS) {
    return {
      identity: conn.account,
      access,
      state: "attention",
      status: `reconnect within ${Math.max(1, Math.ceil(left / 86_400_000))} days`,
    };
  }
  return {
    identity: conn.team ? `${conn.account} · ${conn.team}` : conn.account,
    access,
    state: "ok",
    status: "connected",
  };
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "text-label-sm text-primary border border-primary/40 bg-primary/5 rounded px-2 py-1",
        "whitespace-nowrap transition-colors hover:bg-primary/10",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
        "disabled:opacity-50 disabled:pointer-events-none",
      )}
    >
      {children}
    </button>
  );
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "connected", label: "Connected" },
  { id: "attention", label: "Needs attention" },
];

export default function ConnectionsScreen() {
  const { state } = useCockpitState();
  const [pendingMailbox, setPendingMailbox] = useState<string | null>(null);
  const [slackConn, setSlackConn] = useState<SlackConnection | null>(null);
  const [slackPending, setSlackPending] = useState(false);
  const [filter, setFilter] = useState("all");

  // One-shot read, not part of the cockpit poll: the credential only changes
  // when the user acts, so re-fetch after a connect rather than every tick.
  const loadSlack = useCallback(() => {
    apiGet<SlackConnection>("/api/connections/slack")
      .then(setSlackConn)
      .catch(() => setSlackConn(null));
  }, []);
  useEffect(loadSlack, [loadSlack]);

  // Legacy default: no state yet (first poll in flight or failing) renders
  // the same as "no source errors" — nothing red, no alarm.
  const errs: Record<string, SourceError> = state?.sourceErrors ?? {};
  const slackErr = errs["slack:direct"];
  const gmailErr = errs["gmail:direct"];

  // The browser flow finishes out of band, so re-read a few seconds later —
  // the row turns green without the user reloading the page.
  async function connectSlack() {
    setSlackPending(true);
    try {
      const r = await apiPost<{ detail?: string }>("/api/connections/slack/connect", {});
      toast(r.detail || "Opening the browser…");
      setTimeout(() => {
        loadSlack();
        setSlackPending(false);
      }, 8000);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      setSlackPending(false);
    }
  }

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

  const rows: ConnectorRow[] = useMemo(() => {
    const slack = slackRow(slackConn, !!slackErr);
    return [
      {
        id: "slack",
        name: "Slack",
        ...slack,
        actions: (
          <ActionButton disabled={slackPending} onClick={() => void connectSlack()}>
            {slackPending ? "Opening browser…" : slackConn?.connected ? "Reconnect" : "Connect"}
          </ActionButton>
        ),
      },
      {
        id: "gmail",
        name: "Gmail",
        identity: "4 mailboxes",
        access: "read · draft only, you press Send",
        state: gmailErr ? "attention" : "ok",
        status: gmailErr ? "token expired — cursor frozen, nothing lost" : "connected",
        actions: gmailErr ? (
          <div className="flex flex-col gap-1 items-end">
            {failingGmailMailboxes(gmailErr.message).map((mb) => (
              <ActionButton
                key={mb}
                disabled={pendingMailbox === mb}
                onClick={() => void reauthGmail(mb)}
              >
                {pendingMailbox === mb ? `Opening browser for ${mb}…` : `Reconnect ${mb}`}
              </ActionButton>
            ))}
          </div>
        ) : undefined,
      },
      {
        id: "calendar",
        name: "Google Calendar",
        access: "read · create after approval",
        state: "ok",
        status: "connected · conflict-checked before booking",
      },
      {
        id: "wechat",
        name: "WeChat",
        access: "read via local decrypt · send by paste",
        state: "manual",
        status: "manual by design — no API to connect",
      },
    ];
  }, [slackConn, slackErr, slackPending, gmailErr, pendingMailbox]);

  const visible = rows.filter((r) =>
    filter === "connected" ? r.state === "ok" : filter === "attention" ? r.state === "attention" : true,
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-[60px] bg-surface border-b border-outline flex items-center px-6 flex-shrink-0">
        <h1 className="text-headline">Connections</h1>
      </header>
      <div className="flex-1 bg-background overflow-y-auto p-6 flex justify-center">
        <div className="w-full max-w-[820px] flex flex-col">
          <p className="text-body-medium text-on-surface-variant mb-5 max-w-[68ch]">
            Accounts the engine reads from. Nothing is ever sent without your approval, and there
            are no behavior toggles here — those are fixed by design.
          </p>

          <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />

          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left">
                <th scope="col" className="text-label-sm text-on-surface-variant font-normal py-2.5 pr-4">
                  Connector
                </th>
                <th
                  scope="col"
                  className="hidden md:table-cell text-label-sm text-on-surface-variant font-normal py-2.5 pr-4"
                >
                  Access
                </th>
                <th scope="col" className="text-label-sm text-on-surface-variant font-normal py-2.5">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t border-outline align-top">
                  <td className="py-3.5 pr-4">
                    <div className="flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className={cn("w-2 h-2 rounded-full mt-[7px] flex-shrink-0", DOT_CLS[r.state])}
                      />
                      <div className="min-w-0">
                        <div className="text-body-medium text-on-surface">{r.name}</div>
                        {r.identity && (
                          <div className="text-label-sm text-on-surface-variant truncate">
                            {r.identity}
                          </div>
                        )}
                        {/* Access is a column on wide screens and a third line here when it isn't. */}
                        <div className="md:hidden text-label-sm text-on-surface-variant opacity-70 mt-0.5">
                          {r.access}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="hidden md:table-cell py-3.5 pr-4 text-label-sm text-on-surface-variant">
                    {r.access}
                  </td>
                  <td className="py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className={cn(
                          "text-label-sm",
                          r.state === "attention" ? "text-error" : "text-on-surface-variant",
                        )}
                      >
                        {r.status}
                      </span>
                      {r.actions && <div className="flex-shrink-0">{r.actions}</div>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {visible.length === 0 && (
            <p className="text-body-medium text-on-surface-variant py-8">
              {filter === "attention"
                ? "Nothing needs attention. Every connector is reading normally."
                : "No connector is connected yet — connect one from the All tab."}
            </p>
          )}

          <p className="text-label-sm text-on-surface-variant mt-6 leading-relaxed">
            Detection runs continuously; analysis happens only when something arrives.
          </p>
        </div>
      </div>
    </div>
  );
}
