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
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import ConnectorIcon, { type ConnectorId } from "../components/ConnectorIcon";
import Tabs from "../components/Tabs";
import { apiGet, apiPost } from "../lib/api";
import { cn } from "../lib/cn";
import { toast } from "../lib/toast";
import { useCockpitState, type SourceError } from "../lib/useCockpitState";

interface SlackConnection {
  account: string;
  /** Source label (slack:direct, slack:osyx, …) — keys this account's sourceError. */
  label: string;
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

interface IdentityStatus {
  configured: boolean;
  primaryEmail: string;
}

// First run: config/identity.json is gitignored, so a fresh install has none —
// and without it nothing polls and Connect is inert, because the Keychain
// account key it would write to is empty. Asking here rather than in a terminal
// is the point of the whole one-click onboarding.
function IdentitySetup({ onSaved }: { onSaved: () => void }) {
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await apiPost<{ daemonRestarted?: boolean }>("/api/identity", {
        primaryEmail: email.trim(),
      });
      toast(
        r.daemonRestarted
          ? "Saved. The background daemon restarted with your settings."
          : "Saved. The daemon will use this when it next starts.",
      );
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="max-w-[52ch]">
      <h2 className="text-body-medium text-on-surface mb-1">First, who is this for?</h2>
      <p className="text-label-sm text-on-surface-variant mb-4">
        The secretary reads one person's accounts. This is the only thing it needs before you can
        connect anything — everything else is derived from it, and you can add more mailboxes or
        workspaces later.
      </p>
      <label htmlFor="primaryEmail" className="text-label-sm text-on-surface block mb-1.5">
        Your work email
      </label>
      <div className="flex gap-2">
        <input
          id="primaryEmail"
          type="email"
          required
          autoFocus
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
          placeholder="you@yourcompany.com"
          className={cn(
            "flex-1 text-body-medium text-on-surface bg-surface border border-outline rounded",
            "px-3 py-1.5 placeholder:text-on-surface-variant",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
          )}
        />
        <button
          type="submit"
          disabled={saving || !email.trim()}
          className={cn(
            "text-label-sm text-on-surface bg-surface border border-outline rounded px-3 py-1.5",
            "whitespace-nowrap transition-colors hover:bg-surface-variant",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
            "disabled:opacity-50 disabled:pointer-events-none",
          )}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-label-sm text-on-surface-variant mt-3">
        Stored locally in <code>config/identity.json</code>. Nothing is sent anywhere.
      </p>
    </form>
  );
}

interface ToolSpec {
  key: string;
  label: string;
  config?: { type?: string; url?: string };
}

interface ToolsConfig {
  effective: Record<string, ToolSpec>;
  authorized: Record<string, boolean>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface ConnectorRow {
  id: ConnectorId;
  /** Unique React key + filter identity. Defaults to `id`; set when one
   *  connector (e.g. Slack) renders several rows so keys stay unique. */
  rowKey?: string;
  name: string;
  /** Who/what it is connected as — the second line under the name. */
  identity?: string;
  /** What the connection is allowed to do. */
  access: string;
  state: RowState;
  status: string;
  actions?: React.ReactNode;
  /** Expandable plain-language explanation of what granting access means. */
  note?: React.ReactNode;
}

// What a user actually agrees to when they click Allow. Written out because
// "read your messages" is the part people hesitate over, and the honest answer
// is reassuring — except for the AI provider line, which is the one thing a
// privacy note must not omit. Claiming nothing leaves the Mac would be false.
function SlackPrivacyNote() {
  const rows: Array<[string, string]> = [
    ["Can read", "your DMs, group DMs, channel messages and files — as you"],
    ["Can send", "as you, and only after you approve a specific draft"],
    ["Token stored", "in this Mac's Keychain; it is never transmitted anywhere"],
    [
      "Message text goes",
      "to this Mac, and to the AI provider you configured — with your own API key, billed to you",
    ],
    ["We receive", "nothing. There is no server in this product to receive it"],
    ["Revoke", "any time at slack.com/apps — this app stops reading immediately"],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-label-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-on-surface whitespace-nowrap">{k}</dt>
          <dd className="text-on-surface-variant">{v}</dd>
        </div>
      ))}
    </dl>
  );
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
  // The workspace shown here is the USER's own — the one they picked on Slack's
  // consent screen, which is also the workspace their rate-limit bucket belongs
  // to. It is never the workspace our app happens to be registered in.
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
      // Neutral secondary button, not a tinted primary. Slack, Notion and
      // Atlassian all render connect/disconnect controls this way, and so does
      // the Claude connector list this screen is modelled on: the accent is
      // reserved for the one primary action on a screen, and a settings table
      // has none. Blue on every row read as four competing calls to action.
      className={cn(
        "text-label-sm text-on-surface bg-surface border border-outline rounded px-2.5 py-1",
        "whitespace-nowrap transition-colors hover:bg-surface-variant",
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
  const [slackConns, setSlackConns] = useState<SlackConnection[]>([]);
  const [slackPendingAccount, setSlackPendingAccount] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [tools, setTools] = useState<ToolsConfig | null>(null);
  const [pendingTool, setPendingTool] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentityStatus | null>(null);

  const loadIdentity = useCallback(() => {
    apiGet<IdentityStatus>("/api/identity")
      .then(setIdentity)
      // A failing read must not present the setup form to someone who is
      // already configured — that would invite overwriting a working config.
      .catch(() => setIdentity({ configured: true, primaryEmail: "" }));
  }, []);
  useEffect(loadIdentity, [loadIdentity]);

  const loadTools = useCallback(() => {
    apiGet<ToolsConfig>("/api/settings/tools")
      .then(setTools)
      .catch(() => setTools(null));
  }, []);
  useEffect(loadTools, [loadTools]);

  // Unlike the Slack connect (which spawns and returns), the MCP authorize
  // endpoint holds the request until the browser dance finishes — so this
  // await IS the completion signal and no polling is needed.
  async function connectTool(key: string) {
    setPendingTool(key);
    try {
      await apiPost(`/api/settings/tools/${encodeURIComponent(key)}/authorize`, {});
      loadTools();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setPendingTool(null);
    }
  }

  async function disconnectTool(key: string, label: string) {
    setPendingTool(key);
    try {
      await apiPost(`/api/settings/tools/${encodeURIComponent(key)}/deauthorize`, {});
      // Deliberately not "revoked": MCP servers expose no revoke endpoint, so
      // the grant may still exist at the provider. Saying otherwise would be a
      // false assurance.
      toast(`${label} disconnected on this Mac.`);
      loadTools();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setPendingTool(null);
    }
  }

  async function disconnectSlack(account: string) {
    setSlackPendingAccount(account);
    try {
      const r = await apiPost<{ detail?: string }>("/api/connections/slack/disconnect", { account });
      toast(r.detail || "Disconnected.");
      loadSlack();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSlackPendingAccount(null);
    }
  }

  // One-shot read, not part of the cockpit poll: the credential only changes
  // when the user acts, so re-fetch after a connect rather than every tick.
  const loadSlack = useCallback(() => {
    apiGet<SlackConnection[] | SlackConnection>("/api/connections/slack")
      // The endpoint returns one status per configured workspace. Tolerate a
      // lone object too, so an older server (or a stub) still renders a row.
      .then((d) => setSlackConns(Array.isArray(d) ? d : [d]))
      .catch(() => setSlackConns([]));
  }, []);
  useEffect(loadSlack, [loadSlack]);

  // Legacy default: no state yet (first poll in flight or failing) renders
  // the same as "no source errors" — nothing red, no alarm.
  const errs: Record<string, SourceError> = state?.sourceErrors ?? {};
  const gmailErr = errs["gmail:direct"];

  // The browser flow finishes out of band, so re-read a few seconds later —
  // the row turns green without the user reloading the page.
  async function connectSlack(account: string) {
    setSlackPendingAccount(account);
    try {
      const r = await apiPost<{ detail?: string }>("/api/connections/slack/connect", { account });
      toast(r.detail || "Opening the browser…");
      setTimeout(() => {
        loadSlack();
        setSlackPendingAccount(null);
      }, 8000);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
      setSlackPendingAccount(null);
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

  // Jira and Notion authorize through the MCP OAuth that Settings → Tools
  // already drives, so these rows are generated from the same registry rather
  // than hardcoded: adding an MCP tool there makes it appear here too.
  const mcpRows: ConnectorRow[] = useMemo(
    () =>
      Object.values(tools?.effective ?? {})
        .filter((t) => t.config?.type === "mcp" && t.config?.url)
        .map((t) => {
          const authorized = !!tools?.authorized[t.key];
          return {
            id: t.key as ConnectorId,
            name: t.label,
            identity: hostOf(t.config!.url!),
            // Not a source: these never originate action items, they are looked
            // up for context and written to when a card is approved.
            access: "context lookup · create after approval",
            state: authorized ? ("ok" as const) : ("manual" as const),
            status: authorized ? "connected" : "not connected",
            actions: authorized ? (
              <ActionButton
                disabled={pendingTool === t.key}
                onClick={() => void disconnectTool(t.key, t.label)}
              >
                {pendingTool === t.key ? "Working…" : "Disconnect"}
              </ActionButton>
            ) : (
              <ActionButton
                disabled={pendingTool === t.key}
                onClick={() => void connectTool(t.key)}
              >
                {pendingTool === t.key ? "Opening browser…" : "Connect"}
              </ActionButton>
            ),
          };
        }),
    [tools, pendingTool, disconnectTool],
  );

  const rows: ConnectorRow[] = useMemo(() => {
    // One row per configured Slack workspace (Taiv + OSYX, …). Each carries its
    // OWN sourceError (keyed by the account's label) and its own connect /
    // disconnect action, so a dead OSYX token no longer hides behind Taiv.
    const slackRows: ConnectorRow[] = slackConns.map((conn, i) => {
      const pending = slackPendingAccount === conn.account;
      return {
        id: "slack" as const,
        rowKey: `slack:${conn.account}`,
        name: "Slack",
        ...slackRow(conn, !!errs[conn.label]),
        // The privacy note is identical for every workspace — show it once.
        ...(i === 0 ? { note: <SlackPrivacyNote /> } : {}),
        actions: conn.connected ? (
          <ActionButton disabled={pending} onClick={() => void disconnectSlack(conn.account)}>
            {pending ? "Working…" : "Disconnect"}
          </ActionButton>
        ) : (
          <ActionButton disabled={pending} onClick={() => void connectSlack(conn.account)}>
            {pending ? "Opening browser…" : "Connect"}
          </ActionButton>
        ),
      };
    });
    return [
      ...slackRows,
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
      // WeChat is deliberately absent: integration is not on the near roadmap,
      // and a permanently grey "manual by design" row is noise on a screen
      // whose job is showing what needs acting on. relay/io/wechat-cli.ts and
      // the specs stay — this only hides the row.
      ...mcpRows,
    ];
  }, [slackConns, errs, slackPendingAccount, gmailErr, pendingMailbox, mcpRows]);

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
          {identity && !identity.configured ? (
            <IdentitySetup
              onSaved={() => {
                loadIdentity();
                loadSlack();
              }}
            />
          ) : (
          <>
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
                <Fragment key={r.rowKey ?? r.id}>
                <tr className="border-t border-outline align-top">
                  <td className="py-3.5 pr-4">
                    <div className="flex items-start gap-2.5">
                      <span className="flex-shrink-0 mt-px">
                        <ConnectorIcon id={r.id} />
                      </span>
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
                        {r.note && (
                          <button
                            type="button"
                            aria-expanded={openNote === r.id}
                            onClick={() => setOpenNote(openNote === r.id ? null : r.id)}
                            className={cn(
                              "text-label-sm text-primary mt-1 transition-colors hover:underline",
                              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
                            )}
                          >
                            {openNote === r.id ? "Hide details" : "What access means"}
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hidden md:table-cell py-3.5 pr-4 text-label-sm text-on-surface-variant">
                    {r.access}
                  </td>
                  <td className="py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      {/* The dot lives with the words it qualifies. In the name
                          cell it read as a bullet; here it is the status. */}
                      <span
                        className={cn(
                          "text-label-sm flex items-start gap-2",
                          r.state === "attention" ? "text-error" : "text-on-surface-variant",
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "w-2 h-2 rounded-full mt-[5px] flex-shrink-0",
                            DOT_CLS[r.state],
                          )}
                        />
                        {r.status}
                      </span>
                      {r.actions && <div className="flex-shrink-0">{r.actions}</div>}
                    </div>
                  </td>
                </tr>
                {/* The disclosure spans the full width directly under its own
                    row rather than squeezing into the name cell — it is prose,
                    not a column. */}
                {r.note && openNote === r.id && (
                  <tr>
                    <td colSpan={3} className="pb-4 pl-[30px] pr-4">
                      <div className="bg-surface-variant rounded p-3.5">{r.note}</div>
                    </td>
                  </tr>
                )}
                </Fragment>
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
          </>
          )}
        </div>
      </div>
    </div>
  );
}
