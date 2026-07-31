// Projects screen (S4) — React port of legacy public/js/projects.js (Microsoft
// To-Do style): a sidebar of projects grouped by company plus a Misc catch-all,
// and a main pane with the project's open cards, needs/gaps, blockers, and a
// (collapsed) current-state section. Clicking a card jumps to the Queue with
// that card selected — legacy set App.selectedId + switched screen; here the
// card id travels as react-router location state for the Queue screen (S5) to
// pick up.
//
// Data cadence matches legacy switchScreen("projects"): /api/projects is
// refetched on EVERY entry (cheap, and the cards mirror the live queue) and
// never polled; a failed refetch is silent, exactly like legacy's .catch({}).
//
// One deliberate addition over legacy: the API sends p.blockers but the
// vanilla screen never rendered them — they now get a block styled like the
// needs/gaps one. Also, the legacy header gradient was hard-coded blue-50; it
// is from-primary/10 here so it tracks the theme.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Circle, CircleCheck, Inbox, type LucideIcon } from "lucide-react";
import { apiGet } from "../lib/api";
import { cn } from "../lib/cn";
import { clip, isChinese } from "../lib/text";

// ─── payload types (GET /api/projects → { projects, misc }) ──────────

interface ProjectCardLite {
  id: string;
  action_type: string;
  status: string;
  headline: string;
  summary: string;
  next_actions?: string[];
  sender_name?: string;
  missing_info?: string[];
}

interface ProjectNeed {
  need: string;
  status?: string; // "gap" | "partial" (the server already filters to those)
}

interface Project {
  id: string;
  company: string;
  name: string;
  goal: string;
  status: string;
  current_state: string;
  needs: ProjectNeed[];
  blockers: string[];
  cards: ProjectCardLite[];
}

interface ProjectsData {
  projects: Project[];
  misc: ProjectCardLite[];
}

const COMPANY_LABEL: Record<string, string> = {
  oushikesi: "欧思克斯 · OUS",
  osyx: "OSYX",
  taiv: "Taiv",
  tool: "Tools",
  tools: "Tools",
};

const MISC_ID = "__misc";

// ─── sidebar ─────────────────────────────────────────────────────────

function ListRow({
  id,
  icon: Icon,
  label,
  n,
  active,
  onSelect,
}: {
  id: string;
  icon: LucideIcon;
  label: string;
  n: number;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2 rounded-md cursor-pointer text-left",
        active ? "bg-primary/10" : "hover:bg-surface-variant",
      )}
    >
      <Icon size={18} strokeWidth={1.75} className={active ? "text-primary" : "text-on-surface-variant"} />
      <span
        className={cn(
          "text-body-medium truncate",
          active ? "text-primary font-semibold" : "text-on-surface",
          isChinese(label) && "font-chinese",
        )}
      >
        {label}
      </span>
      {n > 0 && (
        <span
          className={cn(
            "ml-auto text-label-xs px-1.5 rounded-full",
            active ? "text-primary bg-surface" : "text-on-surface-variant bg-surface-variant",
          )}
        >
          {n}
        </span>
      )}
    </button>
  );
}

// ─── main pane ───────────────────────────────────────────────────────

function ProjectMain({ p }: { p: Project }) {
  const navigate = useNavigate();
  const cards = p.cards ?? [];

  const taskRow = (c: ProjectCardLite) => {
    const naCount = (c.next_actions ?? []).length;
    const needs = !!c.missing_info && c.missing_info.length > 0;
    return (
      // A card row jumps to the Queue with that card selected (legacy wired
      // App.selectedId + switchScreen("queue")); the Queue screen is S5, so
      // the id rides along as location state until it learns to read it.
      <button
        key={c.id}
        type="button"
        onClick={() => navigate("/", { state: { selectedId: c.id } })}
        className="group w-full text-left flex items-start gap-3 bg-surface border border-outline rounded-lg px-4 py-3 cursor-pointer hover:border-primary/50 transition-colors"
      >
        <Circle size={20} strokeWidth={1.75} className="text-on-surface-variant group-hover:text-primary mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("text-body-medium text-on-surface truncate", isChinese(c.headline) && "font-chinese")}>
              {c.headline || "(untitled)"}
            </span>
            <span className="text-label-xs uppercase tracking-wide text-on-surface-variant bg-surface-variant px-1.5 py-0.5 rounded flex-shrink-0">
              {c.action_type}
            </span>
            {needs && <span className="text-label-xs text-amber-600 dark:text-amber-400 flex-shrink-0">needs info</span>}
          </div>
          {c.summary && (
            <div className={cn("text-label-sm text-on-surface-variant truncate", isChinese(c.summary) && "font-chinese")}>
              {c.summary}
            </div>
          )}
          <div className={cn("text-label-xs text-on-surface-variant mt-0.5", isChinese(c.sender_name) && "font-chinese")}>
            {c.sender_name ?? ""}
            {naCount ? ` · ${naCount} action${naCount > 1 ? "s" : ""}` : ""}
          </div>
        </div>
      </button>
    );
  };

  const needs = p.needs ?? [];
  const blockers = p.blockers ?? [];

  return (
    <>
      <div className="bg-gradient-to-b from-primary/10 to-transparent px-6 pt-6 pb-4 border-b border-outline">
        <div className="flex items-center gap-2 mb-1">
          {p.company && (
            <span className="text-label-xs uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded">
              {COMPANY_LABEL[p.company] ?? p.company}
            </span>
          )}
          {p.status && <span className="text-label-xs text-on-surface-variant">{p.status}</span>}
          <span className="ml-auto text-label-sm text-on-surface-variant">{cards.length} open</span>
        </div>
        <h1 className={cn("text-display", isChinese(p.name) && "font-chinese")}>{p.name}</h1>
        {p.goal && (
          <p className={cn("text-body-medium text-on-surface-variant mt-2 max-w-3xl", isChinese(p.goal) && "font-chinese")}>
            {clip(p.goal, 320)}
          </p>
        )}
      </div>
      <div className="px-6 pt-4 pb-24 max-w-3xl">
        <div className="flex flex-col gap-2">
          {cards.length ? (
            cards.map(taskRow)
          ) : (
            <div className="text-on-surface-variant text-body-base py-10 text-center">No open cards for this project.</div>
          )}
        </div>
        {needs.length > 0 && (
          <div className="mt-8">
            <h3 className="text-label-sm uppercase tracking-wider text-on-surface-variant mb-2">Open needs / gaps</h3>
            <div className="flex flex-col gap-1.5">
              {needs.map((n, i) => (
                <div key={i} className={cn("flex items-start gap-2 text-body-base text-on-surface", isChinese(n.need) && "font-chinese")}>
                  <span
                    className={cn(
                      "text-label-xs uppercase mt-1 flex-shrink-0",
                      n.status === "gap" ? "text-error" : "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {n.status ?? ""}
                  </span>
                  <span>{n.need}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {blockers.length > 0 && (
          <div className="mt-8">
            <h3 className="text-label-sm uppercase tracking-wider text-on-surface-variant mb-2">Blockers</h3>
            <div className="flex flex-col gap-1.5">
              {blockers.map((b, i) => (
                <div key={i} className={cn("flex items-start gap-2 text-body-base text-on-surface", isChinese(b) && "font-chinese")}>
                  <span className="w-1.5 h-1.5 rounded-full bg-error mt-2 flex-shrink-0" />
                  <span>{b}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {p.current_state && (
          <details className="mt-8">
            <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">Project state</summary>
            <p className={cn("mt-2 text-body-medium text-on-surface-variant whitespace-pre-wrap", isChinese(p.current_state) && "font-chinese")}>
              {clip(p.current_state, 1500)}
            </p>
          </details>
        )}
      </div>
    </>
  );
}

// ─── screen ──────────────────────────────────────────────────────────

export default function ProjectsScreen() {
  const [data, setData] = useState<ProjectsData | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<ProjectsData>("/api/projects")
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        /* legacy swallowed this too — the loading state just stays */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-base min-h-0">
        Loading projects…
      </div>
    );
  }

  const projects = data.projects ?? [];
  const misc = data.misc ?? [];
  const sel = selectedProject ?? projects[0]?.id ?? MISC_ID;

  // Group projects by company, preserving first-seen order (legacy Map).
  const groups = new Map<string, Project[]>();
  for (const p of projects) {
    const key = p.company || "other";
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }

  let main: React.ReactNode;
  if (sel === MISC_ID) {
    main = (
      <ProjectMain
        p={{ id: MISC_ID, name: "Misc", company: "", goal: "Cards not tied to a tracked project.", status: "", current_state: "", needs: [], blockers: [], cards: misc }}
      />
    );
  } else {
    const p = projects.find((x) => x.id === sel) ?? projects[0];
    main = p ? (
      <ProjectMain p={p} />
    ) : (
      <div className="p-6 text-on-surface-variant">No projects yet.</div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      <aside className="w-[280px] flex-shrink-0 border-r border-outline bg-surface overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-2 flex flex-col gap-0.5">
        <div className="px-3 py-3 text-headline">Projects</div>
        <ListRow id={MISC_ID} icon={Inbox} label="Misc" n={misc.length} active={sel === MISC_ID} onSelect={setSelectedProject} />
        {[...groups.entries()].map(([company, ps]) => (
          <div key={company}>
            <div className="px-3 pt-4 pb-1 text-label-xs uppercase tracking-wider text-on-surface-variant">
              {COMPANY_LABEL[company] ?? company}
            </div>
            {ps.map((p) => (
              <ListRow
                key={p.id}
                id={p.id}
                icon={CircleCheck}
                label={p.name}
                n={(p.cards ?? []).length}
                active={sel === p.id}
                onSelect={setSelectedProject}
              />
            ))}
          </div>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto bg-background">{main}</div>
    </div>
  );
}
