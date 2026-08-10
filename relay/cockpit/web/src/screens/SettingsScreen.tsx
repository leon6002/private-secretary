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
import { AnimatePresence, motion } from "framer-motion";
import { Info, Plus } from "lucide-react";
import { ModelBrandIcon, type ModelBrandId } from "../components/ConnectorIcon";
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
  timezone: string;
  keys: { anthropic: KeyStatus; deepseek: KeyStatus };
}

interface ActivityRecord {
  at: string;
  kind: string;
  summary: string;
  data?: Record<string, unknown>;
}

// ─── General ─────────────────────────────────────────────────────────

// A settings row: label and description on the left, the control on the right.
// Apple's settings pattern, and the reason General can hold several unrelated
// controls without becoming a wall of headings.
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3.5 border-b border-outline last:border-b-0">
      <div className="min-w-0">
        <div className="text-body-medium text-on-surface">{label}</div>
        {hint && <div className="text-label-sm text-on-surface-variant mt-0.5">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

const THEME_OPTIONS: Array<{ id: ThemePreference; label: string }> = [
  { id: "system", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

// A segmented control, not three described buttons. The preference has THREE
// states — Auto is not decoration, it tracks the OS live — so a binary switch
// could not express it. Segmented keeps all three visible at a glance and the
// selection is the only thing that moves.
function ThemeSegmented() {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex rounded-md bg-surface-variant p-0.5"
    >
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={preference === o.id}
          onClick={() => setPreference(o.id)}
          className={cn(
            "px-3 py-1 rounded text-label-sm transition-colors",
            preference === o.id
              ? "bg-surface text-on-surface shadow-none"
              : "text-on-surface-variant hover:text-on-surface",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Every IANA zone the browser knows. Intl.supportedValuesOf has shipped in
// Safari and Chrome for years; the fallback exists so a stray older engine
// gets a usable list rather than an empty dropdown.
function allTimeZones(detected: string): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  ).supportedValuesOf;
  const list = supported ? supported("timeZone") : [detected, "UTC"];
  return list.includes(detected) ? list : [detected, ...list];
}

// The owner's zone: the clock every relative date ("tomorrow 9am") resolves
// against, and the zone a meeting is read in when the conversation does not
// name one.
//
// A dropdown, not a text field: the value has to be an exact IANA name, and a
// field that accepts "Portugal time" only to reject it makes the user guess at
// a spelling. Locked until Edit is pressed, because this is a setting you set
// once and then only ever change by accident — the extra click is the point.
function TimezoneRow() {
  const [saved, setSaved] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [zones] = useState(() => allTimeZones(detected));

  useEffect(() => {
    apiGet<{ timezone?: string }>("/api/settings")
      .then((s) => setSaved(s.timezone ?? detected))
      .catch(() => undefined);
  }, [detected]);

  async function save(next: string) {
    if (next === saved) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const r = await apiPost<{ timezone: string }>("/api/settings/timezone", { timezone: next });
      setSaved(r.timezone);
      setEditing(false);
      toast(`Timezone set to ${r.timezone}. Takes effect on the next daemon start.`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row
      label="Timezone"
      hint={'Anchors dates like "tomorrow 9am" and reads meetings stated without a zone.'}
    >
      <div className="flex gap-2 items-center">
        <select
          value={saved}
          disabled={!editing || busy}
          aria-label="Timezone"
          onChange={(e) => void save(e.target.value)}
          className={cn(
            "w-[15rem] text-label-sm rounded-lg border px-2 py-1.5 bg-surface",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
            editing
              ? "border-primary text-on-surface"
              : "border-outline text-on-surface-variant appearance-none",
          )}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
              {z === detected ? "  (this Mac)" : ""}
            </option>
          ))}
        </select>
        <Button variant="ghost" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : "Edit"}
        </Button>
      </div>
    </Row>
  );
}

function GeneralTab() {
  return (
    <div className="max-w-[62ch]">
      <Row label="Theme" hint="Auto follows the macOS appearance, including live changes.">
        <ThemeSegmented />
      </Row>
      <TimezoneRow />
    </div>
  );
}

// ─── Model ───────────────────────────────────────────────────────────
// Backend and key are ONE decision, so they are one tab. Split across "Model"
// and "Keys" the relationship had to be explained in prose ("needs the
// Anthropic key") and acted on in two places; here the key lives inside the
// provider that needs it, and picking a backend with no key shows the empty
// field immediately.

const MODE_OPTIONS: Array<{
  id: LlmMode;
  brand: ModelBrandId;
  label: string;
  hint: string;
  // The Keychain service this backend needs, if any. CLI borrows the Claude
  // Code subscription and has no key of its own.
  key?: "anthropic" | "deepseek";
}> = [
  {
    id: "cli",
    brand: "claude",
    label: "Claude Code",
    hint: "Runs claude -p against your subscription. No API spend, no key.",
  },
  {
    id: "anthropic",
    brand: "anthropic",
    label: "Anthropic API",
    hint: "Billed per token.",
    key: "anthropic",
  },
  {
    id: "deepseek",
    brand: "deepseek",
    label: "DeepSeek",
    hint: "Chat-completions. Cheaper, and the drafts are noticeably plainer.",
    key: "deepseek",
  },
];

// The key field for the selected provider. No status dot and no repeated
// provider name — the row it sits in already says which provider this is.
function ProviderKey({
  service,
  status,
  onChanged,
}: {
  service: "anthropic" | "deepseek";
  status: KeyStatus;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // Two-click remove: the first click arms, the second sends the delete (an
  // empty value means "remove" server-side). No modal — the armed state IS the
  // confirmation, and losing a key is re-pasteable, not destructive.
  const [armingRemove, setArmingRemove] = useState(false);

  async function submit(next: string, verb: string) {
    setBusy(true);
    try {
      await apiPost("/api/settings/keys", { service, value: next });
      toast(`API key ${verb}`);
      setEditing(false);
      setValue("");
      setArmingRemove(false);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="paste the key — it is never shown again"
          aria-label={`${service} key value`}
          autoFocus
          className="flex-1 min-w-0 rounded-lg border border-outline bg-surface px-2.5 py-1.5 text-body-base text-on-surface outline-none focus:border-primary"
        />
        <Button onClick={() => void submit(value, "saved to the Keychain")} disabled={busy || !value.trim()}>
          Save
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
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-label-sm text-on-surface-variant flex-1">
        {status.configured ? `Key stored in the macOS Keychain · ${status.preview ?? ""}` : "No key yet"}
      </span>
      <Button variant="ghost" onClick={() => setEditing(true)}>
        {status.configured ? "Replace" : "Add key"}
      </Button>
      {status.configured && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => (armingRemove ? void submit("", "removed") : setArmingRemove(true))}
          className={cn(armingRemove && "border-error/40 text-error")}
        >
          {armingRemove ? "Click again to remove" : "Remove"}
        </Button>
      )}
    </div>
  );
}

function ModelTab({
  llm,
  keys,
  onChanged,
}: {
  llm: SettingsData["llm"];
  keys: SettingsData["keys"];
  onChanged: () => void;
}) {
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
    <div className="flex flex-col gap-4 max-w-[62ch]">
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Drafting backend">
        {MODE_OPTIONS.map((o) => {
          const selected = mode === o.id;
          return (
            <div
              key={o.id}
              className={cn(
                "rounded-xl border transition-colors",
                selected ? "border-primary bg-primary/5" : "border-outline hover:bg-surface-variant",
              )}
            >
              <label className="flex items-center gap-3 px-3.5 py-3 cursor-pointer">
                <ModelBrandIcon id={o.brand} size={22} />
                <span className="flex-1 min-w-0">
                  <span className="block text-body-medium text-on-surface">{o.label}</span>
                  <span className="block text-label-sm text-on-surface-variant">{o.hint}</span>
                </span>
                <input
                  type="radio"
                  name="llm-mode"
                  value={o.id}
                  checked={selected}
                  onChange={() => setMode(o.id)}
                  className="accent-primary flex-shrink-0"
                />
              </label>
              {/* The chosen backend's own settings, revealed in place. The
                  height animates from 0 so the list does not jump. */}
              <AnimatePresence initial={false}>
                {selected && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: "spring", bounce: 0, duration: 0.3 }}
                    className="overflow-hidden"
                  >
                    <div className="px-3.5 pb-3.5 pt-1 flex flex-col gap-2.5 border-t border-outline/60 mt-0.5">
                      <label className="flex items-center gap-2">
                        <span className="text-label-sm text-on-surface w-[5.5rem] flex-shrink-0">
                          Draft model
                        </span>
                        <input
                          type="text"
                          value={draftModel}
                          onChange={(e) => setDraftModel(e.target.value)}
                          placeholder={o.id === "cli" ? "opus" : o.id === "anthropic" ? "claude-opus-4-8" : "deepseek-v4-pro"}
                          className="flex-1 min-w-0 rounded-lg border border-outline bg-surface px-2.5 py-1.5 text-body-base text-on-surface outline-none focus:border-primary"
                        />
                      </label>
                      {o.key && (
                        <ProviderKey service={o.key} status={keys[o.key]} onChanged={onChanged} />
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !draftModel.trim()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <span className="text-label-sm text-on-surface-variant">
          The model name is passed to the backend as-is.
        </span>
      </div>

      {restartNotice && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400 px-3 py-2 text-body-base"
        >
          Restart the daemon for changes to take effect.
        </div>
      )}

      <p className="text-label-sm text-on-surface-variant leading-relaxed">
        Keys are stored only in the macOS Keychain — never written to a file, and the full value is
        never shown here (at most the last 4 characters). Slack and Google have their own
        authorization flows on the Connections screen.
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


interface UpdateStatusDto {
  running: string;
  current: string;
  currentSubject: string;
  latest: string;
  behind: number;
  dirty: boolean;
  branch: string;
  error?: string;
}
interface UpdateRunDto {
  ok: boolean;
  from: string;
  to: string;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  needsRestart: boolean;
}

// A checkbox that persists on click, with no Save button — a two-state
// preference has nothing to confirm, and a toggle that needs saving reads as
// broken.
function AutoUpdateRow() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<{ autoUpdate?: boolean }>("/api/settings")
      .then((s) => setOn(!!s.autoUpdate))
      .catch(() => setOn(false));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setOn(next); // optimistic: the checkbox must not lag the click
    try {
      await apiPost("/api/settings/auto-update", { autoUpdate: next });
    } catch (e) {
      setOn(!next);
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex items-center gap-2 mt-4 cursor-pointer select-none w-fit">
      <input
        type="checkbox"
        checked={!!on}
        disabled={on === null || busy}
        onChange={(e) => void toggle(e.target.checked)}
        className="accent-primary"
      />
      <span className="text-label-sm text-on-surface">
        Install updates automatically
        <span className="text-on-surface-variant">
          {" "}
          — checked every half hour; the app restarts itself when one lands.
        </span>
      </span>
    </label>
  );
}

// Updating without a terminal. One button: it checks when there is nothing to
// install and installs when there is, because "check" and "update" were never
// really two decisions the user wanted to make.
//
// The restart is not a third button either — it follows the install. The
// cockpit is one of the processes being restarted, so it cannot report the
// outcome of its own restart; the page confirms by watching the running commit
// change, then reloads itself so it is not left on the old bundle.
function UpdateTab() {
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  const [run, setRun] = useState<UpdateRunDto | null>(null);
  const [busy, setBusy] = useState<"" | "checking" | "updating" | "restarting">("");

  const load = useCallback((force = false) => {
    setBusy("checking");
    apiGet<UpdateStatusDto>(`/api/update${force ? "?force=1" : ""}`)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setBusy(""));
  }, []);
  useEffect(() => load(), [load]);

  // Wait for the restart the server fired after answering, then reload — a tab
  // left on the previous bundle would render old markup against the new API.
  async function awaitRestart(before: string | undefined) {
    setBusy("restarting");
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const s = await apiGet<UpdateStatusDto>("/api/update");
        if (s.running && s.running !== before) {
          window.location.reload();
          return;
        }
      } catch {
        /* still down — keep waiting */
      }
    }
    setBusy("");
    toast("Restart is taking longer than expected — check the logs.", true);
  }

  async function check() {
    setRun(null);
    load(true);
  }

  async function update() {
    setBusy("updating");
    setRun(null);
    // The RUNNING commit, not HEAD: HEAD moves during the pull, so watching it
    // could never tell whether the restart happened.
    const before = status?.running;
    try {
      const r = await apiPost<UpdateRunDto>("/api/update", {});
      setRun(r);
      if (r.ok && r.needsRestart) {
        await awaitRestart(before);
        return;
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
    setBusy("");
    load();
  }

  const upToDate = !!status && !status.error && status.behind === 0;
  // "Update now" only when an update can actually be applied. A dirty checkout
  // or a failed check leaves the button on Check — offering Update there would
  // promise something the server is going to refuse. Checking itself is always
  // allowed: it reads git, it changes nothing, and blocking it was the fastest
  // way to make a stuck install look unfixable.
  const canUpdate = !!status && !status.error && !status.dirty && status.behind > 0;
  const label =
    busy === "updating"
      ? "Updating…"
      : busy === "restarting"
        ? "Restarting…"
        : busy === "checking"
          ? "Checking…"
          : canUpdate
            ? "Update now"
            : "Check for updates";

  return (
    <div className="max-w-[62ch]">
      <h2 className="text-body-large text-on-surface font-medium mb-1">Software update</h2>
      <p className="text-label-sm text-on-surface-variant mb-4">
        Pulls the latest version, installs it and restarts itself. Nothing here needs a terminal.
      </p>

      {status && !status.error && status.behind > 0 && (
        <p className="text-body-medium text-primary mb-3">
          A new version is available — {status.behind} commit
          {status.behind === 1 ? "" : "s"} behind.
        </p>
      )}

      {status?.error ? (
        <p className="text-label-sm text-error">Could not check for updates: {status.error}</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-label-sm mb-4">
          <dt className="text-on-surface">Running</dt>
          <dd className="text-on-surface-variant">
            {status ? `${status.running}${status.running !== status.current ? " (restart pending)" : ` · ${status.currentSubject}`}` : "…"}
          </dd>
          <dt className="text-on-surface">Available</dt>
          <dd className="text-on-surface-variant">
            {!status
              ? "…"
              : upToDate
                ? "up to date"
                : `${status.latest} · ${status.behind} commit${status.behind === 1 ? "" : "s"} ahead`}
          </dd>
        </dl>
      )}

      {status?.dirty && (
        <p className="text-label-sm text-error mb-3">
          This install has local changes, so updating is blocked — applying one would discard
          them.
        </p>
      )}

      <Button onClick={() => void (canUpdate ? update() : check())} disabled={busy !== ""}>
        {label}
      </Button>

      <AutoUpdateRow />

      {run && (
        <ul className="mt-4 flex flex-col gap-1">
          {run.steps.map((s) => (
            <li key={s.step} className="text-label-sm flex gap-2">
              <span className={s.ok ? "text-emerald-500" : "text-error"}>{s.ok ? "✓" : "✗"}</span>
              <span className="text-on-surface">{s.step}</span>
              {s.detail && <span className="text-on-surface-variant">— {s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TABS = [
  { id: "general", label: "General" },
  { id: "model", label: "Model" },
  { id: "google", label: "Google" },
  { id: "tools", label: "Tools" },
  { id: "activity", label: "Activity" },
  { id: "update", label: "Update" },
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
          {tab === "update" && <UpdateTab />}
          {tab === "model" && settings && (
            <ModelTab llm={settings.llm} keys={settings.keys} onChanged={reload} />
          )}
          {tab === "google" && <GoogleTab />}
          {tab === "tools" && <ToolsTab />}
          {tab === "activity" && <ActivityTab />}
        </div>
      </div>
    </div>
  );
}
