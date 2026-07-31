// Settings screen (S3) — four tabs:
//   General   theme three-state (System / Light / Dark) via useTheme()
//   Model     drafting backend + model, persisted to config/secretary-settings.json
//             (POST /api/settings/llm; the daemon picks it up on its NEXT start)
//   Keys      Anthropic / DeepSeek API keys, stored ONLY in the macOS Keychain
//             (POST /api/settings/keys) — the UI ever sees is a last-4 preview
//   Activity  the F3 activity-log view ported from legacy public/js/activity.js
//             (kind filter chips, newest first, 15s poll)
//
// /api/settings is fetched once by the screen and shared by the Model + Keys
// tabs; Key saves call reload() so the status dots/previews refresh.
import { useCallback, useEffect, useState } from "react";
import Button from "../components/Button";
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

// ─── screen ──────────────────────────────────────────────────────────

const TABS = [
  { id: "general", label: "General" },
  { id: "model", label: "Model" },
  { id: "keys", label: "Keys" },
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
          {tab === "activity" && <ActivityTab />}
        </div>
      </div>
    </div>
  );
}
