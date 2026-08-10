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
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import ConnectorIcon, { type ConnectorId } from "../components/ConnectorIcon";
import Tabs from "../components/Tabs";
import { apiGet, apiPost } from "../lib/api";
import { cn } from "../lib/cn";
import { toast } from "../lib/toast";
import { useCockpitState, type SourceError } from "../lib/useCockpitState";

interface SlackCredential {
  present: boolean;
  team?: string;
  /** Access-token expiry. Machinery — never surfaced; see reconnectBy. */
  expiresAt: number;
  /** When re-consent becomes necessary (refresh window), 0 if never. */
  reconnectBy: number;
}

interface SlackWorkspace {
  account: string;
  label: string;
  active: "legacy" | "oauth" | "none";
  legacy: SlackCredential;
  oauth: SlackCredential;
}

interface SlackConnection {
  workspaces: SlackWorkspace[];
}

// "slack:leo-test" → "leo test". The label is the only stable name we have
// before a credential exists; the team name only arrives with a bundle.
function workspaceName(w: SlackWorkspace): string {
  return w.oauth?.team || w.label.replace(/^slack:/, "").replace(/-/g, " ");
}

// The Keychain key is shown only when it means something to a human. Older
// entries use an email; one-click ones use "team:T0123ABCD", which is an
// internal key and would be noise on the row.
function workspaceIdentity(w: SlackWorkspace): string | undefined {
  return w.account.includes("@") ? w.account : undefined;
}

// Warn a week out from the re-consent deadline. The deadline itself moves
// forward on every refresh, so a running daemon never reaches it — this only
// fires for a machine that has been off, which is exactly when a week of
// notice is useful.
const RECONNECT_WARN_MS = 7 * 24 * 60 * 60 * 1000;

// Sentinel for the "add a workspace" flow, which has no account yet — the
// user only picks the workspace on Slack's page.
const ADD_PENDING = "__add__";

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

// Restoring the unthrottled path means pasting a token from the user's own
// Slack app — our OAuth flow can only ever issue OUR app's token, which is the
// rate-limited one.
function LegacyTokenForm({ account, onSaved }: { account: string; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiPost("/api/connections/slack/legacy", { token: token.trim(), account });
      setToken("");
      toast("Saved. This token is now the one in use.");
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex gap-2 items-start">
      <input
        type="password"
        value={token}
        onChange={(ev) => setToken(ev.target.value)}
        placeholder="xoxp-…"
        aria-label="User token from your own Slack app"
        className={cn(
          "w-[15rem] text-label-sm text-on-surface bg-surface border border-outline rounded",
          "px-2 py-1 placeholder:text-on-surface-variant",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
        )}
      />
      <ActionButton disabled={saving || !token.trim()} onClick={() => {}} type="submit">
        {saving ? "Saving…" : "Save"}
      </ActionButton>
    </form>
  );
}

// Registering a workspace from an own-app token. Separate from the per-row
// paste field, which only fills in a credential for a workspace that is
// already registered — this one creates the entry.
function AddLegacyWorkspaceForm({ onAdded }: { onAdded: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await apiPost<{ team: string; user: string; added: boolean }>(
        "/api/connections/slack/add-legacy",
        { token: token.trim() },
      );
      setToken("");
      toast(
        r.added
          ? `Added ${r.team} (signed in as ${r.user}).`
          : `${r.team} was already registered — its token is updated.`,
      );
      onAdded();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex gap-2 items-start">
      <input
        type="password"
        value={token}
        onChange={(ev) => setToken(ev.target.value)}
        placeholder="xoxp-…"
        aria-label="User token from a Slack app you created"
        className={cn(
          "w-[15rem] text-label-sm text-on-surface bg-surface border border-outline rounded",
          "px-2 py-1 placeholder:text-on-surface-variant",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
        )}
      />
      <ActionButton type="submit" disabled={saving || !token.trim()}>
        {saving ? "Checking…" : "Add with own token"}
      </ActionButton>
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
  /** Which brand mark to draw. Two rows share "slack" on purpose. */
  id: ConnectorId;
  /** Unique per row; defaults to id. Needed because the two Slack rows share
   *  an icon but must not share a React key or a disclosure toggle. */
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

// The one-click credential (our Slack app). Rate-limited until the app is on
// the Marketplace, so it is NOT automatically the one in use.
function oauthRow(
  w: SlackWorkspace,
  hasError: boolean,
): Pick<ConnectorRow, "identity" | "access" | "state" | "status"> {
  const access = "read · send after approval";
  const inUse = w.active === "oauth";
  if (hasError && inUse) {
    return { identity: workspaceIdentity(w), access, state: "attention", status: "token issue — cursor frozen, nothing lost" };
  }
  const c = w.oauth;
  if (!c?.present) {
    return { identity: workspaceIdentity(w), access, state: "manual", status: "not connected" };
  }
  const identity = workspaceIdentity(w);
  // Deliberately NOT expiresAt: that is the ~12h access token the runtime
  // refreshes silently. Warning on it would paint this row red permanently.
  const left = c.reconnectBy - Date.now();
  if (c.reconnectBy && left <= 0) {
    return { identity, access, state: "attention", status: "sign-in expired — reconnect to resume" };
  }
  if (c.reconnectBy && left < RECONNECT_WARN_MS) {
    return {
      identity,
      access,
      state: "attention",
      status: `reconnect within ${Math.max(1, Math.ceil(left / 86_400_000))} days`,
    };
  }
  return { identity, access, state: "ok", status: inUse ? "connected · in use" : "connected · standby" };
}

// A token pasted from the user's OWN Slack app. Slack treats that as an
// internal custom app: 50+ requests/minute against our 1/minute, which is why
// it wins when both exist and why removing it is not casually reversible.
function legacyRow(
  w: SlackWorkspace,
  hasError: boolean,
): Pick<ConnectorRow, "identity" | "access" | "state" | "status"> {
  const access = "read · send after approval · no rate cap";
  const inUse = w.active === "legacy";
  if (hasError && inUse) {
    return { identity: workspaceIdentity(w), access, state: "attention", status: "token issue — cursor frozen, nothing lost" };
  }
  if (!w.legacy?.present) {
    return { identity: workspaceIdentity(w), access, state: "manual", status: "not set" };
  }
  return { identity: workspaceIdentity(w), access, state: "ok", status: "connected · in use" };
}

function ActionButton({
  children,
  disabled,
  onClick,
  type = "button",
  title,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
}) {
  return (
    <button
      type={type}
      title={title}
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
  const [slackConn, setSlackConn] = useState<SlackConnection | null>(null);
  // Per ACCOUNT, not a single flag: with several workspaces one global
  // boolean would disable every row while one of them is connecting.
  const [slackPendingAccount, setSlackPendingAccount] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  // The own-app token path stays folded away until asked for — see the section
  // near the bottom of the table.
  const [ownTokenOpen, setOwnTokenOpen] = useState(false);
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

  async function disconnectSlack(which: "legacy" | "oauth", account: string) {
    setSlackPendingAccount(account ?? ADD_PENDING);
    try {
      const r = await apiPost<{ detail?: string }>("/api/connections/slack/disconnect", {
        which,
        account,
      });
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
    apiGet<SlackConnection>("/api/connections/slack")
      .then(setSlackConn)
      .catch(() => setSlackConn(null));
  }, []);
  useEffect(loadSlack, [loadSlack]);

  // Legacy default: no state yet (first poll in flight or failing) renders
  // the same as "no source errors" — nothing red, no alarm.
  const errs: Record<string, SourceError> = state?.sourceErrors ?? {};
  const gmailErr = errs["gmail:direct"];

  // The browser flow finishes out of band, so re-read a few seconds later —
  // the row turns green without the user reloading the page.
  async function connectSlack(mode: "reauth" | "add", account?: string) {
    setSlackPendingAccount(account ?? ADD_PENDING);
    try {
      const r = await apiPost<{ detail?: string }>("/api/connections/slack/connect", {
        mode,
        ...(account ? { account } : {}),
      });
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
    return [
      // Two rows per workspace: ours and the user's own app token. They are
      // separate credentials with very different rate limits, so collapsing
      // them would hide which one is actually carrying the traffic.
      ...(slackConn?.workspaces ?? []).flatMap((w): ConnectorRow[] => {
        const name = workspaceName(w);
        // Its OWN sourceError, keyed by this workspace's label — a shared
        // lookup would paint a healthy workspace red for another's failure.
        const err = errs[w.label];
        return [
          {
            id: "slack",
            rowKey: `${w.account}-oauth`,
            name: `Slack · ${name}`,
            ...oauthRow(w, !!err),
            note: <SlackPrivacyNote />,
            actions: w.oauth?.present ? (
              <ActionButton
                disabled={slackPendingAccount === w.account}
                onClick={() => void disconnectSlack("oauth", w.account)}
              >
                {slackPendingAccount === w.account ? "Working…" : "Disconnect"}
              </ActionButton>
            ) : (
              <ActionButton
                disabled={slackPendingAccount === w.account}
                onClick={() => void connectSlack("reauth", w.account)}
              >
                {slackPendingAccount === w.account ? "Opening browser…" : "Connect"}
              </ActionButton>
            ),
          },
          {
            id: "slack",
            rowKey: `${w.account}-legacy`,
            name: `Slack · ${name} · your own app`,
            ...legacyRow(w, !!err),
            actions: w.legacy?.present ? (
              // Deliberately disabled. This credential cannot be reissued from
              // here — our flow only ever mints OUR app's (rate-limited) token
              // — so a stray click would cost the only unthrottled path.
              <ActionButton
                disabled
                title="Protected: this token comes from your own Slack app and cannot be restored from here. Remove it in Keychain if you really mean to."
              >
                Disconnect
              </ActionButton>
            ) : (
              <LegacyTokenForm account={w.account} onSaved={loadSlack} />
            ),
          },
        ];
      }),
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
  }, [slackConn, errs, slackPendingAccount, gmailErr, pendingMailbox, mcpRows]);

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
                            aria-expanded={openNote === (r.rowKey ?? r.id)}
                            onClick={() => setOpenNote(openNote === (r.rowKey ?? r.id) ? null : (r.rowKey ?? r.id))}
                            className={cn(
                              "text-label-sm text-primary mt-1 transition-colors hover:underline",
                              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
                            )}
                          >
                            {openNote === (r.rowKey ?? r.id) ? "Hide details" : "What access means"}
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
                          // nowrap: the paste form shares this cell, and a
                          // two-word status was wrapping mid-phrase beside it.
                          "text-label-sm flex items-start gap-2 whitespace-nowrap",
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
                {r.note && openNote === (r.rowKey ?? r.id) && (
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

          {/* Two ways in, but they are not equals, and showing them as two
              anonymous columns said they were. One click is the path almost
              everyone takes; a token from your own Slack app is the escape
              hatch for a mailbox too busy for our rate cap, and it belongs one
              level deeper — not as a bare password field sitting in the open. */}
          <section className="mt-6 rounded-xl border border-outline bg-surface p-4 max-w-[62ch]">
            <div className="flex items-center gap-2.5">
              <ConnectorIcon id="slack" />
              <h2 className="text-body-medium text-on-surface flex-1">Add a Slack workspace</h2>
              <ActionButton
                disabled={slackPendingAccount === ADD_PENDING}
                onClick={() => void connectSlack("add")}
              >
                {slackPendingAccount === ADD_PENDING ? "Opening browser…" : "Connect"}
              </ActionButton>
            </div>
            <p className="text-label-sm text-on-surface-variant mt-1.5">
              You pick the workspace on Slack's own page. Rate-limited to 1 request a minute until
              our app is listed on the Slack Marketplace.
            </p>

            <button
              type="button"
              onClick={() => setOwnTokenOpen((v) => !v)}
              aria-expanded={ownTokenOpen}
              className={cn(
                "mt-3 flex items-center gap-1 text-label-sm text-on-surface-variant",
                "hover:text-on-surface transition-colors",
              )}
            >
              <ChevronRight
                size={14}
                className={cn("transition-transform", ownTokenOpen && "rotate-90")}
              />
              Use a token from your own Slack app
            </button>
            <AnimatePresence initial={false}>
              {ownTokenOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: "spring", bounce: 0, duration: 0.3 }}
                  className="overflow-hidden"
                >
                  <div className="pt-3">
                    <p className="text-label-sm text-on-surface-variant mb-2">
                      No rate cap — this is what a busy workspace needs. The token itself says
                      which workspace it belongs to.
                    </p>
                    <AddLegacyWorkspaceForm onAdded={loadSlack} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

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
