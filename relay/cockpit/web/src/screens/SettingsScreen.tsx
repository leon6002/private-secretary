// Settings screen (S3) — five tabs:
//   General   theme three-state (System / Light / Dark) via useTheme()
//   Model     drafting backend + model, persisted to config/secretary-settings.json
//             (POST /api/settings/llm; the daemon picks it up on its NEXT start)
//   Keys      Anthropic / DeepSeek API keys, stored ONLY in the macOS Keychain
//             (POST /api/settings/keys) — the UI ever sees is a last-4 preview
//   Google    first-time Gmail + Calendar onboarding (SETUP.md §3) as a 5-step
//             guide: store the OAuth client JSON, then authorize each mailbox
//   Activity  the F3 activity-log view ported from legacy public/js/activity.js
//             (kind filter chips, newest first, 15s poll)
//
// /api/settings is fetched once by the screen and shared by the Model + Keys
// tabs; Key saves call reload() so the status dots/previews refresh.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Info, Plus } from "lucide-react";
import Button from "../components/Button";
import { Textarea } from "../components/ui/textarea";
import Tabs from "../components/Tabs";
import { apiGet, apiPost } from "../lib/api";
import { cn } from "../lib/cn";
import { useTheme, type ThemePreference } from "../lib/theme";
import { timeAgo } from "../lib/time";
import { toast } from "../lib/toast";

type LlmMode = "cli" | "anthropic" | "deepseek";

interface KeyStatus {
  configured: boolean;
  preview: string | null;
}

interface SettingsData {
  llm: { mode: LlmMode; draftModel: string };
  keys: { anthropic: KeyStatus; deepseek: KeyStatus };
}

interface ActivityRecord {
  at: string;
  kind: string;
  summary: string;
  data?: Record<string, unknown>;
}

// ─── General ─────────────────────────────────────────────────────────

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "follows macOS appearance" },
  { id: "light", label: "Light", hint: "always light" },
  { id: "dark", label: "Dark", hint: "always dark" },
];

function GeneralTab() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="flex flex-col gap-3">
      <div className="text-body-medium text-on-surface">Theme</div>
      <div className="flex gap-2">
        {THEME_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={preference === o.id}
            onClick={() => setPreference(o.id)}
            className={cn(
              "rounded border px-3 py-2 text-left transition-colors",
              preference === o.id
                ? "border-primary text-primary bg-primary/5"
                : "border-outline text-on-surface-variant hover:text-on-surface",
            )}
          >
            <div className="text-body-medium">{o.label}</div>
            <div className="text-label-sm opacity-70">{o.hint}</div>
          </button>
        ))}
      </div>
      <p className="text-label-sm text-on-surface-variant leading-relaxed">
        Stored on this machine only. System tracks the macOS appearance setting,
        including live changes while the cockpit is open.
      </p>
    </div>
  );
}

// ─── Model ───────────────────────────────────────────────────────────

const MODE_OPTIONS: Array<{ id: LlmMode; label: string; hint: string }> = [
  { id: "cli", label: "CLI (claude -p)", hint: "Claude Code subscription — no API spend" },
  { id: "anthropic", label: "Anthropic API", hint: "billed per token, needs the Anthropic key" },
  { id: "deepseek", label: "DeepSeek", hint: "chat-completions, needs the DeepSeek key" },
];

function ModelTab({ llm }: { llm: SettingsData["llm"] }) {
  const [mode, setMode] = useState<LlmMode>(llm.mode);
  const [draftModel, setDraftModel] = useState(llm.draftModel);
  const [saving, setSaving] = useState(false);
  // Stays up once a save succeeds: the running daemon still has the OLD
  // config until it restarts, and forgetting that is the classic confusion.
  const [restartNotice, setRestartNotice] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await apiPost("/api/settings/llm", { mode, draftModel });
      toast("Model settings saved");
      setRestartNotice(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Drafting backend">
        {MODE_OPTIONS.map((o) => (
          <label
            key={o.id}
            className={cn(
              "flex items-start gap-2 rounded border px-3 py-2 cursor-pointer transition-colors",
              mode === o.id ? "border-primary bg-primary/5" : "border-outline hover:bg-surface-variant",
            )}
          >
            <input
              type="radio"
              name="llm-mode"
              value={o.id}
              checked={mode === o.id}
              onChange={() => setMode(o.id)}
              className="mt-1"
            />
            <span>
              <span className="block text-body-medium text-on-surface">{o.label}</span>
              <span className="block text-label-sm text-on-surface-variant">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-body-medium text-on-surface">Draft model</span>
        <input
          type="text"
          value={draftModel}
          onChange={(e) => setDraftModel(e.target.value)}
          className="rounded border border-outline bg-surface px-2 py-1.5 text-body-base text-on-surface outline-none focus:border-primary"
        />
        <span className="text-label-sm text-on-surface-variant">
          e.g. opus, claude-opus-4-8, deepseek-v4-pro — passed to the selected backend as-is.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !draftModel.trim()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {restartNotice && (
        <div
          role="status"
          className="rounded border border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400 px-3 py-2 text-body-base"
        >
          Restart the daemon for changes to take effect.
        </div>
      )}
    </div>
  );
}

// ─── Keys ────────────────────────────────────────────────────────────

function KeyRow({
  service,
  label,
  status,
  onChanged,
}: {
  service: "anthropic" | "deepseek";
  label: string;
  status: KeyStatus;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // Two-click remove: the first click arms, the second sends the delete
  // (an empty value means "remove" server-side). No modal — the armed state
  // IS the confirmation.
  const [armingRemove, setArmingRemove] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await apiPost("/api/settings/keys", { service, value });
      toast(`${label} updated`);
      setEditing(false);
      setValue("");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!armingRemove) {
      setArmingRemove(true);
      return;
    }
    setBusy(true);
    try {
      await apiPost("/api/settings/keys", { service, value: "" });
      toast(`${label} removed`);
      setArmingRemove(false);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-surface border border-outline rounded p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "w-2.5 h-2.5 rounded-full flex-shrink-0",
            status.configured ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600",
          )}
        />
        <div className="flex-1">
          <div className="text-body-medium text-on-surface">{label}</div>
          <div className="text-label-sm text-on-surface-variant">
            {status.configured ? `configured · ${status.preview ?? ""}` : "not configured"}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setEditing(true)}>
              {status.configured ? "Replace" : "Add"}
            </Button>
            {status.configured && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void remove()}
                className={cn(armingRemove && "border-error/40 text-error")}
              >
                {armingRemove ? "Click again to remove" : "Remove"}
              </Button>
            )}
          </div>
        )}
      </div>
      {editing && (
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="paste the key — it is never shown again"
            aria-label={`${label} value`}
            className="flex-1 rounded border border-outline bg-surface px-2 py-1.5 text-body-base text-on-surface outline-none focus:border-primary"
          />
          <Button onClick={() => void save()} disabled={busy || !value.trim()}>
            Save to macOS Keychain
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setValue("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function KeysTab({ keys, onChanged }: { keys: SettingsData["keys"]; onChanged: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <KeyRow service="anthropic" label="Anthropic API key" status={keys.anthropic} onChanged={onChanged} />
      <KeyRow service="deepseek" label="DeepSeek API key" status={keys.deepseek} onChanged={onChanged} />
      <p className="text-label-sm text-on-surface-variant mt-2 leading-relaxed">
        Keys are stored only in the macOS Keychain — never written to a file, and the full value is
        never shown here (at most the last 4 characters). Slack and Google tokens have their own
        flows and are not editable here.
      </p>
    </div>
  );
}

// ─── Google ──────────────────────────────────────────────────────────
// First-time Gmail + Calendar onboarding (SETUP.md §3) as a guided flow.
// One consent covers BOTH gmail.modify and calendar.events — Gmail and
// Calendar share a single authorization per mailbox, and the copy says so
// so nobody expects a second dance for Calendar.

interface GoogleMailbox {
  email: string;
  authorized: boolean;
  isCalendar: boolean;
}

interface GoogleSetupData {
  clientConfigured: boolean;
  mailboxes: GoogleMailbox[];
}

// Numbered guide step. Steps with a computable completion state (4: client
// stored, 5: every mailbox authorized) flip their badge to a check; 1–3 are
// manual console work and stay neutral.
function GuideStep({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-surface border border-outline rounded p-4 flex gap-3">
      <span
        className={cn(
          "w-6 h-6 rounded-full border flex items-center justify-center flex-shrink-0 text-label-sm",
          done ? "border-emerald-500 text-emerald-600 dark:text-emerald-400" : "border-outline text-on-surface-variant",
        )}
      >
        {done ? "✓" : n}
      </span>
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        <div className="text-body-medium text-on-surface">{title}</div>
        {children}
      </div>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        "w-2.5 h-2.5 rounded-full flex-shrink-0",
        ok ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600",
      )}
    />
  );
}

function GoogleTab() {
  const [setup, setSetup] = useState<GoogleSetupData | null>(null);
  const [clientJson, setClientJson] = useState("");
  const [saving, setSaving] = useState(false);
  // Email of the mailbox whose authorize request is in flight — one browser
  // flow at a time is confusing enough already.
  const [authorizing, setAuthorizing] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiGet<GoogleSetupData>("/api/settings/google")
      .then(setSetup)
      .catch((e) => toast(e instanceof Error ? e.message : String(e), true));
  }, []);
  useEffect(reload, [reload]);

  async function saveClient() {
    setSaving(true);
    try {
      await apiPost("/api/settings/google/client", { json: clientJson });
      toast("OAuth client stored in the macOS Keychain");
      setClientJson("");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  }

  async function authorize(email: string) {
    setAuthorizing(email);
    try {
      await apiPost("/api/settings/google/authorize", { mailbox: email });
      toast(`Browser opened — sign in as ${email} and accept`);
      // The consent script writes the token bundle when the browser flow
      // finishes — a beat after this response — so the dot may lag one reload.
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setAuthorizing(null);
    }
  }

  const allAuthorized =
    setup != null && setup.mailboxes.length > 0 && setup.mailboxes.every((m) => m.authorized);

  return (
    <div className="flex flex-col gap-4">
      {/* status overview */}
      <div className="bg-surface border border-outline rounded p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <StatusDot ok={setup?.clientConfigured ?? false} />
          <div className="flex-1 text-body-base text-on-surface">OAuth client</div>
          <span className="text-label-sm text-on-surface-variant">
            {setup ? (setup.clientConfigured ? "configured" : "not configured") : "…"}
          </span>
        </div>
        {setup?.mailboxes.map((m) => (
          <div key={m.email} className="flex items-center gap-2">
            <StatusDot ok={m.authorized} />
            <div className="flex-1 min-w-0 text-body-base text-on-surface truncate">
              {m.email}
              {m.isCalendar && (
                <span className="ml-2 text-label-xs rounded border border-outline text-on-surface-variant px-1.5 py-0.5">
                  calendar
                </span>
              )}
            </div>
            <span className="text-label-sm text-on-surface-variant">
              {m.authorized ? "authorized" : "not authorized"}
            </span>
          </div>
        ))}
      </div>

      {/* the 5-step guide */}
      <GuideStep n={1} title="Create a Google Cloud project and enable the APIs">
        <p className="text-body-base text-on-surface-variant leading-relaxed">
          In the{" "}
          <a
            href="https://console.cloud.google.com/"
            target="_blank"
            rel="noreferrer"
            className="text-primary underline"
          >
            Google Cloud console
          </a>
          , create a project, then enable the <strong>Gmail API</strong> and the{" "}
          <strong>Google Calendar API</strong>.
        </p>
      </GuideStep>
      <GuideStep n={2} title="Configure the OAuth consent screen">
        <p className="text-body-base text-on-surface-variant leading-relaxed">
          Choose <strong>External</strong> and add yourself as a <strong>Test user</strong> — an
          un-published app only consents for listed test users.
        </p>
      </GuideStep>
      <GuideStep n={3} title="Create and download the OAuth client JSON">
        <p className="text-body-base text-on-surface-variant leading-relaxed">
          Under <strong>Credentials</strong>, create an <strong>OAuth client ID</strong> of type{" "}
          <strong>Desktop app</strong> and download the JSON.
        </p>
      </GuideStep>
      <GuideStep n={4} done={setup?.clientConfigured} title="Store the client JSON in the Keychain">
        <p className="text-body-base text-on-surface-variant leading-relaxed">
          Paste the downloaded JSON below. It is stored only in the macOS Keychain — never written
          to a file.
        </p>
        <textarea
          value={clientJson}
          onChange={(e) => setClientJson(e.target.value)}
          placeholder='{"installed": {"client_id": "…", …}}'
          aria-label="OAuth client JSON"
          rows={4}
          className="rounded border border-outline bg-surface px-2 py-1.5 text-body-base text-on-surface font-mono outline-none focus:border-primary resize-y"
        />
        <div>
          <Button onClick={() => void saveClient()} disabled={saving || !clientJson.trim()}>
            {saving ? "Saving…" : "Save to macOS Keychain"}
          </Button>
        </div>
      </GuideStep>
      <GuideStep n={5} done={allAuthorized} title="Authorize each mailbox">
        <p className="text-body-base text-on-surface-variant leading-relaxed">
          Opens a browser per mailbox — sign in as that address and accept. One consent grants both
          Gmail and Calendar.
        </p>
        <div className="flex flex-col gap-2">
          {(setup?.mailboxes ?? []).map((m) => (
            <div key={m.email} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-body-base text-on-surface truncate">{m.email}</span>
              {m.authorized ? (
                <>
                  <span className="text-label-sm text-on-surface-variant">authorized</span>
                  <Button
                    variant="ghost"
                    disabled={authorizing !== null}
                    onClick={() => void authorize(m.email)}
                  >
                    Re-authorize
                  </Button>
                </>
              ) : (
                <Button
                  disabled={!setup?.clientConfigured || authorizing !== null}
                  onClick={() => void authorize(m.email)}
                >
                  {authorizing === m.email ? "Opening…" : `Authorize ${m.email}`}
                </Button>
              )}
            </div>
          ))}
          {setup && setup.mailboxes.length === 0 && (
            <p className="text-label-sm text-on-surface-variant">
              No mailboxes configured — set up config/identity.json first (see SETUP.md).
            </p>
          )}
        </div>
      </GuideStep>

      <p className="text-label-sm text-on-surface-variant leading-relaxed">
        Gmail and Calendar share the single authorization above. In External Testing mode the
        refresh token expires after 7 days — when that happens, come back here and Re-authorize.
        Publishing the consent screen removes the 7-day limit.
      </p>
    </div>
  );
}

// ─── Activity ────────────────────────────────────────────────────────
// Behavioral reference: legacy public/js/activity.js — same chips, same row
// layout, same 15s poll. Newest first; a failed poll keeps the last good list.

const ACTIVITY_KINDS = [
  "tick",
  "supersede",
  "auto-execute",
  "approve",
  "skip",
  "edit",
  "restore",
  "mark-done",
  "error",
];

// Kind chip tones stay inside the DESIGN.md palette (verbatim legacy):
// red for errors, primary for the human's own approvals, amber for the
// machine acting alone, neutral hairline for everything else.
const KIND_TONE: Record<string, string> = {
  error: "text-error border-error/40",
  approve: "text-primary border-primary/40",
  "auto-execute": "text-amber-600 border-amber-500/40",
};

function ActivityTab() {
  const [kind, setKind] = useState("");
  const [records, setRecords] = useState<ActivityRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await apiGet<{ records: ActivityRecord[] }>(
          `/api/activity?tail=200${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`,
        );
        if (!cancelled) setRecords(d.records ?? []);
      } catch {
        /* a failed poll keeps the last good render (legacy behavior) */
      }
    }
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [kind]);

  const chipCls = (active: boolean) =>
    cn(
      "text-label-sm rounded border px-2 py-0.5 transition-colors",
      active
        ? "border-primary text-primary bg-primary/5"
        : "border-outline text-on-surface-variant hover:text-on-surface",
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5 flex-wrap">
        <button type="button" className={chipCls(kind === "")} onClick={() => setKind("")}>
          all
        </button>
        {ACTIVITY_KINDS.map((k) => (
          <button key={k} type="button" className={chipCls(kind === k)} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        {records.length === 0 ? (
          <div className="text-body-base text-on-surface-variant py-8 text-center">
            nothing yet — the log fills as the daemon scans and you triage
          </div>
        ) : (
          // The log is chronological (oldest→newest); the screen shows newest first.
          [...records].reverse().map((r, i) => {
            const tone = KIND_TONE[r.kind] ?? "text-on-surface-variant border-outline";
            // Error ticks carry the failing sources' messages in data.errors —
            // that's the actual diagnostic, surface it under the summary.
            const errors = (r.data?.errors ?? {}) as Record<string, string>;
            return (
              <div
                key={`${r.at}-${i}`}
                className="bg-surface border border-outline rounded px-3 py-2 flex items-baseline gap-3"
              >
                <span className="text-label-sm text-on-surface-variant w-[64px] flex-shrink-0" title={r.at}>
                  {timeAgo(r.at)}
                </span>
                <span className={cn("text-label-xs rounded border px-1.5 py-0.5 flex-shrink-0", tone)}>
                  {r.kind}
                </span>
                <span className="text-body-base text-on-surface min-w-0 break-words">
                  {r.summary}
                  {Object.values(errors).map((m, j) => (
                    <div key={j} className="text-label-sm text-error/80 mt-0.5">
                      {m}
                    </div>
                  ))}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── MCP Tools ───────────────────────────────────────────────────────
// The connected task-processing MCPs (config/tools.json). Built-in tools
// (jira) are always available; this tab manages ADDITIONAL / override tools
// the user wired. Saving POSTs the user config; the effective registry
// (built-ins merged) shows up in the Queue's "via" picker.

interface ToolConfigEntry {
  label: string;
  requiredParams: string[];
  config?: Record<string, string>;
}
type EffectiveTool = { label: string; requiredParams: string[]; config?: Record<string, string> };

// A raw-JSON editor for the MCP tools config (config/tools.json) — the same
// shape mainstream clients use: a map of tool-key → spec. Simpler and more
// flexible than a per-field form; invalid JSON is caught before save.
function ToolsTab() {
  const [jsonText, setJsonText] = useState("");
  const [effective, setEffective] = useState<Record<string, EffectiveTool>>({});
  const [authorized, setAuthorized] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [authorizingKey, setAuthorizingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiGet<{
      tools: Record<string, ToolConfigEntry>;
      effective: Record<string, EffectiveTool>;
      authorized: Record<string, boolean>;
    }>("/api/settings/tools")
      .then((d) => {
        setJsonText(JSON.stringify(d.tools ?? {}, null, 2));
        setEffective(d.effective ?? {});
        setAuthorized(d.authorized ?? {});
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), true));
  }, []);
  useEffect(reload, [reload]);

  const connectTool = async (key: string) => {
    setAuthorizingKey(key);
    try {
      await apiPost(`/api/settings/tools/${encodeURIComponent(key)}/authorize`, {});
      toast(`${key} connected`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setAuthorizingKey(null);
      reload();
    }
  };

  // URL-based MCP tools (the ones that need OAuth) → the "Connect" list.
  const mcpTools = Object.entries(effective).filter(
    ([, s]) => s.config?.type === "mcp" && s.config?.url,
  );

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setError(`Invalid JSON — ${(e as Error).message}`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await apiPost("/api/settings/tools", { tools: parsed });
      toast("Tools saved");
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  };

  const activeTools = Object.entries(effective)
    .map(([k, s]) => `${s.label} (${k})`)
    .join(", ");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-body-large text-on-surface font-medium">MCP tools</h2>
        <p className="text-label-sm text-on-surface-variant mt-1 max-w-[60ch] leading-relaxed">
          Edit config/tools.json as JSON — the same shape mainstream clients use (a map of tool key →
          spec). Approve runs a stub until each tool's real MCP runner is wired.
        </p>
      </div>

      <Textarea
        value={jsonText}
        onChange={(e) => setJsonText(e.target.value)}
        aria-label="MCP tools JSON config"
        spellCheck={false}
        className="min-h-[240px] w-full font-mono text-label-sm leading-relaxed resize-y"
        placeholder={`{
  "notion": {
    "label": "Notion",
    "requiredParams": ["title", "content"],
    "config": {
      "type": "mcp",
      "url": "https://mcp.notion.com/mcp",
      "defaultTool": "notion-create-pages"
    }
  }
}`}
      />

      {error && <div className="text-red-600 text-label-sm">{error}</div>}

      {/* OAuth connections for URL-based MCP tools — connect directly here. */}
      {mcpTools.length > 0 && (
        <div className="rounded-xl border border-outline overflow-hidden bg-surface">
          <div className="px-4 py-2.5 border-b border-outline text-label-sm text-on-surface-variant">
            Connections
          </div>
          {mcpTools.map(([key, s]) => {
            const connected = authorized[key];
            const url = s.config?.url ?? "";
            return (
              <div
                key={key}
                className="px-4 py-2.5 flex items-center justify-between gap-3 border-b border-outline last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="text-body-medium text-on-surface truncate">
                    {s.label} <code className="text-label-xs font-mono text-on-surface-variant">({key})</code>
                  </div>
                  <div className="text-label-xs text-on-surface-variant truncate">{url}</div>
                </div>
                {connected ? (
                  <span className="text-label-sm text-emerald-600 flex-shrink-0">✓ Connected</span>
                ) : (
                  <Button
                    variant="primary"
                    disabled={authorizingKey === key}
                    onClick={() => void connectTool(key)}
                    className="text-label-sm flex-shrink-0"
                  >
                    {authorizingKey === key ? "Authorizing…" : "Connect"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border border-outline bg-surface-variant/60 px-3.5 py-2.5 text-label-sm text-on-surface-variant">
        <span className="font-medium text-on-surface">Active:</span> {activeTools || "—"}
      </div>

      <div className="flex items-center justify-end gap-3">
        <p className="text-label-sm text-on-surface-variant">
          The Queue "via" picker and missing-info checks pick this up immediately after save.
        </p>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ─── screen ──────────────────────────────────────────────────────────

const TABS = [
  { id: "general", label: "General" },
  { id: "model", label: "Model" },
  { id: "keys", label: "Keys" },
  { id: "google", label: "Google" },
  { id: "tools", label: "Tools" },
  { id: "activity", label: "Activity" },
];

export default function SettingsScreen() {
  // Plain useState, not a hash sub-route: four shallow tabs don't earn URL
  // state (reload landing back on General is fine).
  const [tab, setTab] = useState("general");
  const [settings, setSettings] = useState<SettingsData | null>(null);

  const reload = useCallback(() => {
    apiGet<SettingsData>("/api/settings")
      .then(setSettings)
      .catch((e) => toast(e instanceof Error ? e.message : String(e), true));
  }, []);
  useEffect(reload, [reload]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-[60px] bg-surface border-b border-outline flex items-center px-6 flex-shrink-0">
        <h1 className="text-headline">Settings</h1>
      </header>
      <div className="flex-1 bg-background overflow-y-auto p-6 flex justify-center">
        <div className="w-full max-w-[720px] flex flex-col gap-4">
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
          {tab === "general" && <GeneralTab />}
          {tab === "model" && settings && <ModelTab llm={settings.llm} />}
          {tab === "keys" && settings && <KeysTab keys={settings.keys} onChanged={reload} />}
          {tab === "google" && <GoogleTab />}
          {tab === "tools" && <ToolsTab />}
          {tab === "activity" && <ActivityTab />}
        </div>
      </div>
    </div>
  );
}
