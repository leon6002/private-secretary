// People screen (S4) — React port of legacy public/js/people.js, which remains
// the behavioral reference: a compact contact rail (first 5 + a "+N" overflow
// chip) on the left and the full persona profile on the right — header with
// power badge + platform pills, Core-Knowledge field cards (value up front,
// evidence in a hover popover), Voice & Style, the person's live queue items
// (composed server-side into the /api/personas payload — no /api/state call
// here), Commitments ledger, and Open Threads.
//
// Data cadence matches legacy switchScreen("people"): /api/personas is fetched
// when the screen is entered (a React mount), never polled. A failed fetch is
// silent — legacy left the screen on its empty state, and so do we.
//
// Legacy rendered everything as escaped HTML strings; React escapes by itself,
// so escapeHtml has no counterpart here. The v3 persona's Chinese content
// keeps its font-chinese treatment via isChinese(), same as legacy.
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Calendar,
  CircleCheck,
  Clock,
  Lock,
  Mail,
  MessagesSquare,
  MessageSquare,
  Mic,
  Minus,
  Send,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { apiGet } from "../lib/api";
import { Avatar } from "../lib/avatar";
import { cn } from "../lib/cn";
import { clip, isChinese } from "../lib/text";

// ─── payload types (GET /api/personas → { personas: Persona[] }) ─────
// The server composes `fields` (Core Knowledge) and `tasks` (live queue items)
// into the raw v3 persona; only the fields this screen renders are typed here.

interface PersonaField {
  label: string;
  value: string;
  provenance: "manual" | "inferred";
  evidence: string | null;
}

interface PersonaTask {
  id: string;
  action_type: string;
  status: string;
  title: string;
}

interface Commitment {
  who: string; // "them" | "me"
  what: string;
  due?: string;
  status?: string; // "overdue" gets the red tag; anything else renders plain
}

interface Persona {
  key: string;
  display_name?: string;
  avatar?: string;
  identity?: { role?: string; org?: string; relationship?: string };
  relationship_meta?: { power?: string };
  handles?: { slack?: string | null; gmail?: string | null; wechat?: string | null };
  communication?: {
    language?: string;
    register?: string;
    timezone?: string;
    tone_notes?: string;
  };
  fields?: PersonaField[];
  tasks?: PersonaTask[];
  commitments?: Commitment[];
  open_threads?: string[] | string | null;
}

// font-chinese when the text contains CJK — legacy people.js's ch() helper.
const ch = (s: string | null | undefined) => (isChinese(s) ? "font-chinese" : "");

const POWER: Record<string, { label: string; icon: LucideIcon }> = {
  "leads-them": { label: "Leads-them", icon: ArrowUp },
  peer: { label: "Peer", icon: Minus }, // legacy "drag_handle": a single bar
  "serves-them": { label: "Serves-them", icon: ArrowDown },
};

const TASK_ICON: Record<string, LucideIcon> = {
  reply: Send,
  task: CircleCheck,
  calendar: Calendar,
  ignore: Archive,
};

// ─── rail ────────────────────────────────────────────────────────────

const CAP = 5;

// ─── profile pieces ──────────────────────────────────────────────────

function HandlePill({ on, label, icon: Icon, tone }: { on: boolean; label: string; icon: LucideIcon; tone: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg",
        on ? tone : "bg-surface-variant text-on-surface-variant border border-dashed border-outline opacity-50",
      )}
    >
      <Icon size={16} strokeWidth={1.75} />
      <span className="text-label-sm">{label}</span>
    </div>
  );
}

function FieldCard({ f }: { f: PersonaField }) {
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 p-3 rounded-lg bg-background border border-transparent",
        "hover:border-outline hover:shadow-sm transition",
        f.evidence && "cursor-help",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-label-sm text-on-surface-variant">{f.label}</span>
        {f.provenance === "manual" ? (
          <div
            className="flex items-center justify-center w-5 h-5 rounded bg-surface-variant text-on-surface-variant flex-shrink-0"
            title="Manual"
          >
            <Lock size={12} strokeWidth={2} />
          </div>
        ) : (
          <div
            className="flex items-center justify-center w-5 h-5 rounded border border-dashed border-primary text-primary bg-primary/5 flex-shrink-0"
            title="Inferred"
          >
            <span className="text-[10px] font-bold">I</span>
          </div>
        )}
      </div>
      <span className={cn("text-body-base text-on-surface font-medium", ch(f.value))}>{f.value}</span>
      {f.evidence && (
        <div className="absolute z-30 left-2 right-2 top-full bg-surface border border-outline rounded-lg shadow-lg p-3 hidden group-hover:block">
          <div className="text-label-xs uppercase tracking-wider text-on-surface-variant mb-1">Source evidence</div>
          <p className={cn("text-body-medium text-on-surface italic border-l-2 border-primary/40 pl-2", ch(f.evidence))}>
            {clip(f.evidence, 220)}
          </p>
        </div>
      )}
    </div>
  );
}

function Profile({ p }: { p: Persona }) {
  const name = p.display_name || p.key;
  const id = p.identity ?? {};
  const comm = p.communication ?? {};
  const h = p.handles ?? {};
  const power = p.relationship_meta?.power ? POWER[p.relationship_meta.power] : undefined;

  // Platform pills: legacy brand pastels are light-only, so each pill carries
  // a dark: counterpart; hues stay brand-ish (purple Slack, red Gmail, green
  // WeChat) without hard-coded hex.
  const handlePills = (
    <>
      <HandlePill on={!!h.slack} label="Slack" icon={MessageSquare} tone="bg-purple-100 text-purple-900 dark:bg-purple-500/15 dark:text-purple-300" />
      <HandlePill on={!!h.gmail} label="Gmail" icon={Mail} tone="bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-300" />
      <HandlePill on={!!h.wechat} label="WeChat" icon={MessagesSquare} tone="bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" />
    </>
  );

  // Short role/relationship teasers as chips (the full text lives in Core Knowledge).
  const roleShort = id.role ? clip(id.role.split(/[—.]/)[0], 40) : id.org || "";
  const relShort = id.relationship ? clip(id.relationship.split(/[—.]/)[0], 40) : "";
  const lang = comm.language === "zh" ? "中文" : comm.language === "en" ? "English" : comm.language || null;

  // Live local time in the contact's timezone (recomputed each render, as legacy did).
  let timeChip: React.ReactNode = null;
  if (comm.timezone) {
    let t = "";
    try {
      t = new Intl.DateTimeFormat("en-GB", { timeZone: comm.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date());
    } catch {
      /* bad tz — show the zone name without a time */
    }
    timeChip = (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-variant text-on-surface text-label-sm border border-outline">
        <Clock size={14} strokeWidth={1.75} />
        {comm.timezone}
        {t ? ` · ${t}` : ""}
      </span>
    );
  }

  const chipCls = "px-2.5 py-1 rounded-full bg-surface-variant text-on-surface text-label-sm border border-outline";
  const metaChips = [roleShort, relShort, lang, comm.register]
    .filter((v): v is string => !!v)
    .map((v) => (
      <span key={v} className={cn(chipCls, ch(v))}>
        {v}
      </span>
    ));

  // Role/Org are already in the header chips, so they're dropped here (legacy).
  const coreFields = (p.fields ?? []).filter((f) => f.label !== "Role" && f.label !== "Org");

  const tasks = p.tasks ?? [];
  const commits = p.commitments ?? [];
  const them = commits.filter((c) => c.who === "them");
  const me = commits.filter((c) => c.who === "me");

  const otRaw = p.open_threads;
  const otList = Array.isArray(otRaw) ? otRaw : otRaw ? [otRaw] : [];

  const commitRow = (c: Commitment, i: number) => (
    <div key={i} className="flex items-start justify-between gap-2 p-3">
      <span className={cn("text-body-base min-w-0", ch(c.what))}>
        {c.what}
        {c.due && <span className="block text-label-sm text-on-surface-variant">{c.due}</span>}
      </span>
      {c.status === "overdue" && <span className="text-label-xs text-error font-semibold flex-shrink-0">Overdue</span>}
    </div>
  );

  const cardHover = "transition hover:shadow-md";

  return (
    <div className="p-6 xl:px-16 pb-24">
      <div className="max-w-5xl mx-auto flex flex-col gap-6">
        <header className="flex flex-col gap-3">
          <div className="flex items-end justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <h1 className={cn("text-[32px] leading-[40px] font-bold tracking-[-0.02em]", ch(name))}>{name}</h1>
              {power && (
                <div className="flex items-center gap-1 text-primary bg-primary/10 px-2 py-1 rounded-lg border border-primary/20">
                  <power.icon size={16} strokeWidth={1.75} />
                  <span className="text-label-sm font-semibold">{power.label}</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">{handlePills}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {metaChips}
            {timeChip}
          </div>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className={cn("lg:col-span-2 bg-surface rounded-xl border border-outline p-5", cardHover)}>
            <h2 className="text-headline mb-4">Core Knowledge</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {coreFields.length ? (
                coreFields.map((f) => <FieldCard key={f.label} f={f} />)
              ) : (
                <div className="text-on-surface-variant text-body-base sm:col-span-2">— nothing observed yet</div>
              )}
            </div>
          </div>
          <div className={cn("bg-surface rounded-xl border border-outline p-5", cardHover)}>
            <h2 className="text-headline mb-4 flex items-center gap-2">
              <Mic size={20} strokeWidth={1.75} className="text-primary" /> Voice &amp; Style
            </h2>
            <div className="flex flex-col gap-4">
              <div>
                <span className="block text-label-sm text-on-surface-variant mb-1">Tone</span>
                <span className={cn("text-body-base", ch(comm.tone_notes))}>
                  {comm.tone_notes ? (
                    clip(comm.tone_notes, 160)
                  ) : (
                    <span className="text-on-surface-variant italic">— not observed</span>
                  )}
                </span>
              </div>
              <div>
                <span className="block text-label-sm text-on-surface-variant mb-1">Register</span>
                <span className="text-body-base">
                  {comm.register ?? <span className="text-on-surface-variant italic">—</span>}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className={cn("bg-surface rounded-xl border border-outline overflow-hidden", cardHover)}>
          <div className="p-5 border-b border-outline">
            <h2 className="text-headline">Active Tasks</h2>
          </div>
          <div className="flex flex-col">
            {tasks.length ? (
              tasks.map((t) => {
                const Icon = TASK_ICON[t.action_type] ?? Zap;
                return (
                  <div key={t.id} className="px-5 py-3.5 border-b border-outline last:border-0 hover:bg-surface-variant">
                    <div className="flex items-center justify-between gap-4">
                      <span className={cn("text-body-medium truncate", ch(t.title))}>{t.title}</span>
                      {t.status === "approved" ? (
                        <span className="px-2 py-0.5 rounded-full bg-surface-variant text-on-surface-variant text-[10px] uppercase tracking-wider font-bold flex-shrink-0">
                          Waiting
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 text-[10px] uppercase tracking-wider font-bold flex-shrink-0">
                          Action needed
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 text-on-surface-variant">
                      <Icon size={15} strokeWidth={1.75} />
                      <span className="text-label-sm">{t.action_type}</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="px-5 py-4 text-on-surface-variant text-body-base">No active items.</div>
            )}
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className={cn("bg-surface rounded-xl border border-outline overflow-hidden flex flex-col", cardHover)}>
            <div className="p-4 border-b border-outline">
              <h2 className="text-headline">Commitments Ledger</h2>
            </div>
            <div className="grid grid-cols-2 border-b border-outline bg-surface-variant">
              <div className="p-3 text-label-sm text-on-surface-variant uppercase tracking-wider border-r border-outline">They owe</div>
              <div className="p-3 text-label-sm text-on-surface-variant uppercase tracking-wider">I owe</div>
            </div>
            <div className="grid grid-cols-2">
              <div className="border-r border-outline divide-y divide-outline">
                {them.length ? them.map(commitRow) : <div className="p-3 text-on-surface-variant text-label-sm">—</div>}
              </div>
              <div className="divide-y divide-outline">
                {me.length ? me.map(commitRow) : <div className="p-3 text-on-surface-variant text-label-sm">—</div>}
              </div>
            </div>
          </section>
          <section className={cn("bg-surface rounded-xl border border-outline overflow-hidden", cardHover)}>
            <div className="p-4 border-b border-outline">
              <h2 className="text-headline">Open Threads</h2>
            </div>
            <div className="p-4 flex flex-col gap-1">
              {otList.length ? (
                otList.map((t, i) => (
                  <div key={i} className="flex items-start gap-3 py-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                    <span className={cn("text-body-base", ch(t))}>{t}</span>
                  </div>
                ))
              ) : (
                <span className="text-on-surface-variant italic text-body-base">— none open</span>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ─── screen ──────────────────────────────────────────────────────────

export default function PeopleScreen() {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [showAllPeople, setShowAllPeople] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ personas: Persona[] }>("/api/personas")
      .then((d) => {
        if (!cancelled) setPersonas(d.personas ?? []);
      })
      .catch(() => {
        /* legacy had no error path here either — the empty state stands in */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const list = personas ?? [];
  const sel = selectedPerson ?? list[0]?.key;

  // Legacy scrolled the profile pane back to the top when a DIFFERENT person
  // was selected; the rail keeps its own place (React preserves it naturally —
  // no innerHTML replacement here).
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [sel]);

  const shown = showAllPeople ? list : list.slice(0, CAP);
  const rest = list.length - shown.length;
  const person = list.find((p) => p.key === sel);

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      <aside className="w-[72px] flex-shrink-0 bg-surface border-r border-outline flex flex-col items-center py-2 gap-2 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {shown.map((p) => {
          const active = p.key === sel;
          const name = p.display_name || p.key;
          return (
            <button
              key={p.key}
              type="button"
              title={name}
              onClick={() => setSelectedPerson(p.key)}
              className={cn(
                "cursor-pointer transition-opacity",
                active ? "" : "opacity-60 hover:opacity-100",
              )}
            >
              <div className={active ? "ring-2 ring-primary p-[2px] rounded-full" : ""}>
                <Avatar label={name} hueKey={p.key} size={40} photo={p.avatar} />
              </div>
            </button>
          );
        })}
        {!showAllPeople && rest > 0 && (
          <button
            type="button"
            title={`Show all ${list.length}`}
            onClick={() => setShowAllPeople(true)}
            className="w-10 h-10 rounded-full bg-surface-variant text-on-surface-variant flex items-center justify-center text-label-sm font-semibold cursor-pointer hover:bg-outline/20 transition-colors"
          >
            +{rest}
          </button>
        )}
      </aside>
      <div ref={mainRef} className="flex-1 overflow-y-auto bg-background">
        {person ? (
          <Profile p={person} />
        ) : (
          <div className="p-6 text-on-surface-variant text-body-base">No personas yet.</div>
        )}
      </div>
    </div>
  );
}
