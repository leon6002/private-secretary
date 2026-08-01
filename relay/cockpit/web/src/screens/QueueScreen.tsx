// Queue screen (S5) — React port of legacy public/js/queue.js, the Today
// screen (specs/daily-todo.md): the tiered master list of task clusters
// (A→D + Unranked), the task detail with its resolution plan, the typed-skip
// reason picker, drag-to-re-tier, and task-level keyboard control (j/k move,
// a/e/s act — registered here, gated on this screen being mounted, which is
// the React equivalent of legacy main.js's `App.screen !== "queue"` check).
//
// Selection model mirrors legacy's App fields one-to-one:
// - selectedTaskId: task-level selection; the detail pane follows it.
// - selectedId: card-level target for actions, kept consistent with what the
//   detail pane shows (the selected task's footer target) so no code path can
//   act on a card the user has navigated away from.
// - editCardId / editing: the single-card drill-in + draft-edit mode.
// - skipFor: the card the skip-reason panel is open for.
//
// Render helpers are plain functions called as `{fn(x)}`, NOT components:
// their output merges into this component's element tree, so uncontrolled
// inputs (the draft textarea, the <details> expanders) keep their DOM state
// across re-renders — an inline component type would remount and wipe them.
//
// Legacy rendered escaped HTML strings; React escapes by itself, so
// escapeHtml has no counterpart. font-chinese treatment via isChinese() is
// kept for CJK content. Legacy's Chinese UI copy (skip reasons, drawer
// labels, "查看原始消息") is translated to English per the migration's
// copy rule; the skip reason/field KEYS are API values and unchanged.
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  CheckCheck,
  Circle,
  CircleCheck,
  CircleHelp,
  FilePen,
  Folder,
  Hash,
  Inbox,
  Info,
  ListChecks,
  Mail,
  MailOpen,
  MessageSquare,
  RefreshCw,
  Send,
  Shapes,
  User,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { apiPost } from "../lib/api";
import { Avatar } from "../lib/avatar";
import { cn } from "../lib/cn";
import { isChinese } from "../lib/text";
import { timeAgo } from "../lib/time";
import { toast } from "../lib/toast";
import {
  CockpitFeedContext,
  pollGuard,
  useCockpitState,
  type CockpitStateData,
  type QueueAction,
  type TaskCluster,
  type TaskEntity,
  type TaskPlan,
} from "../lib/useCockpitState";

// ─── pure helpers (verbatim ports of queue.js's) ────────────────────

// A cluster's recency = its newest member's created_at (ISO strings sort
// lexically).
function clusterRecency(c: TaskCluster): string {
  let max = "";
  for (const a of c.actions) if (a.created_at > max) max = a.created_at;
  return max;
}
// Clusters newest-first — used ONLY for the flat action list behind
// selectableIds (skip's "select the next card" logic), never for display.
function sortedClusters(clusters: TaskCluster[]): TaskCluster[] {
  return [...clusters].sort((a, b) => clusterRecency(b).localeCompare(clusterRecency(a)));
}
function allLiveActions(clusters: TaskCluster[]): Array<{ action: QueueAction; cluster: TaskCluster }> {
  const out: Array<{ action: QueueAction; cluster: TaskCluster }> = [];
  for (const c of sortedClusters(clusters)) for (const a of c.actions) out.push({ action: a, cluster: c });
  return out;
}
function selectableIds(clusters: TaskCluster[]): string[] {
  return allLiveActions(clusters)
    .filter(({ action }) => action.status === "suggested")
    .map(({ action }) => action.id);
}
// A task cluster's unit key — computed by the backend (getState attaches
// `unit_key`). The id-based derivation stays only as a fallback.
function taskKey(c: TaskCluster): string {
  return c.unit_key || c.task_id || (c.actions[0] ? `__ungrouped_${c.actions[0].id}` : "");
}
// Live task clusters (those with a suggested/approved member).
function liveClusters(clusters: TaskCluster[]): TaskCluster[] {
  return clusters.filter((c) => c.actions.some((a) => a.status === "suggested" || a.status === "approved"));
}

const TIERS = [
  { tier: "A", label: "A · Do first", dot: "bg-red-500" },
  { tier: "B", label: "B · Today", dot: "bg-amber-500" },
  { tier: "C", label: "C · This week", dot: "bg-primary" },
  { tier: "D", label: "D · Later", dot: "bg-slate-400" },
] as const;

// AI-executable action types + the one-click button label (per platform).
function execLabel(a: QueueAction): { assignee: "ai" | "me"; label: string | null; icon: LucideIcon } {
  if (a.action_type === "calendar") return { assignee: "ai", label: "Create event", icon: Calendar };
  if (a.action_type === "reply" || a.action_type === "relay" || a.action_type === "forward") {
    return a.target?.platform === "gmail"
      ? { assignee: "ai", label: "Prepare draft", icon: FilePen }
      : { assignee: "ai", label: "Approve & Send", icon: Send };
  }
  return { assignee: "me", label: null, icon: User }; // task / ignore → Me reminder
}

// The detail footer's own targeting: approve/edit → readyCard (footer
// primary), skip → skipTarget (footer Skip). Skip must work on ANY
// still-suggested card, not only AI-sendable ones — gating it on readyCard
// left `Me · reminder` and `Needs info` cards with no way to skip at all.
function footerTargets(c: TaskCluster): { readyCard?: QueueAction; skipTarget?: QueueAction } {
  const readyCard = c.actions.find(
    (a) => a.status === "suggested" && !(a.missing_info && a.missing_info.length) && execLabel(a).assignee === "ai",
  );
  const skipTarget = readyCard || c.actions.find((a) => a.status === "suggested");
  return { readyCard, skipTarget };
}

// Provenance line parts: "<platform> · <sender> · <MM-DD HH:mm>". Time
// prefers context.sent_at; legacy cards fall back to the Slack ts embedded in
// source_message_id ("slack:<chan>:<ts.ts>"). Blank when neither exists —
// never guess.
function provenanceLine(a: QueueAction): string {
  const platform = a.target?.platform || (a.source_message_id || "").split(":")[0] || "";
  const who = a.sender_name || a.context?.sender_handle || "";
  let d: Date | null = null;
  const iso = a.context?.sent_at;
  if (iso) {
    const parsed = new Date(iso);
    if (!isNaN(parsed.getTime())) d = parsed;
  }
  if (!d && typeof a.source_message_id === "string") {
    const m = a.source_message_id.match(/^slack:[^:]+:(\d+(?:\.\d+)?)$/);
    if (m) d = new Date(parseFloat(m[1]!) * 1000);
  }
  let when = "";
  if (d) when = fmtWhen(d);
  return [platform, who, when].filter(Boolean).join(" · ");
}

function fmtWhen(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── skip reasons (P0 typed skip) ───────────────────────────────────
// ONE click on a reason completes the skip — no confirm step, because the
// value of this instrumentation is entirely fill rate. The field checkboxes
// are optional and ORTHOGONAL: "the time was wrong" is a different fact from
// "this wasn't a real thing". Keys are API values (unchanged); labels are
// English translations of legacy's Chinese copy.
const SKIP_REASONS = [
  { key: "not_a_thing", label: "Not a thing", hint: "should never have been a card" },
  { key: "not_mine", label: "Not mine", hint: "real, but not aimed at me" },
  { key: "duplicate", label: "Duplicate", hint: "same card exists already" },
  { key: "already_handled", label: "Already handled", hint: "dealt with long ago" },
  { key: "deferred", label: "Not now", hint: "card is right, just postponed" },
  { key: "other", label: "Other", hint: "" },
];
const SKIP_FIELDS = [
  { key: "time", label: "Wrong time" },
  { key: "person", label: "Wrong person" },
  { key: "place", label: "Wrong place" },
];

const ENTITY_ICON: Record<string, string> = {
  flight: "✈️",
  file: "📄",
  price: "💰",
  confirmation: "🏨",
  deadline: "📅",
  person: "👤",
  doc: "📝",
};

interface ApproveResult {
  ok?: boolean;
  conflicts?: unknown[];
  awaitingManual?: boolean;
}

// ─── screen ──────────────────────────────────────────────────────────

export default function QueueScreen() {
  // The App shell provides the single shared feed; rendered standalone
  // (tests) the screen falls back to its own instance.
  const shared = useContext(CockpitFeedContext);
  const own = useCockpitState({ enabled: !shared });
  const { state, refresh } = shared ?? own;

  const navigate = useNavigate();
  const location = useLocation();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editCardId, setEditCardId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [skipFor, setSkipFor] = useState<string | null>(null);
  const [skipFields, setSkipFields] = useState<string[]>([]);
  // Approve slide-out: the acted task's card gets .removing while the approve
  // round-trips (legacy animateApprove).
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTier, setDropTier] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const allClusters = state?.clusters ?? [];
  const clusters = liveClusters(allClusters);

  // The Queue's edit mode pauses the shell's 15s poll (legacy App.editing →
  // pollRefresh guard); clear it on unmount so other screens never inherit it.
  useEffect(() => {
    pollGuard.editing = editing;
    return () => {
      pollGuard.editing = false;
    };
  }, [editing]);

  // Focus the draft textarea when edit mode opens (legacy focused #draft-edit
  // right after render).
  useEffect(() => {
    if (editing) draftRef.current?.focus();
  }, [editing, editCardId]);

  // Keep the selected card visible after j/k moves (legacy scrollIntoView).
  useEffect(() => {
    if (!selectedTaskId) return;
    const el = cardRefs.current.get(selectedTaskId);
    // jsdom has no scrollIntoView — the optional call keeps tests quiet.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedTaskId]);

  // A jump from the Projects screen carries a card id as location state
  // (legacy set App.selectedId + switched screen). Select that card's TASK so
  // the detail pane shows it, keep the card as the action target, then clear
  // the state so a later poll doesn't re-select what the user moved on from.
  useEffect(() => {
    const id = (location.state as { selectedId?: string } | null)?.selectedId;
    if (!id || !allClusters.length) return;
    const c = liveClusters(allClusters).find((cl) => cl.actions.some((a) => a.id === id));
    if (c) {
      selectTask(taskKey(c));
      setSelectedId(id);
    }
    navigate(".", { replace: true, state: null });
  }, [allClusters, location.state]);

  // Select a task (master-list click or j/k). selectedId is kept consistent
  // with what the detail pane shows — the task's footer-target card.
  function selectTask(key: string) {
    setSelectedTaskId(key);
    setEditCardId(null);
    setEditing(false);
    const c = clusters.find((cl) => taskKey(cl) === key);
    setSelectedId(c ? (footerTargets(c).skipTarget?.id ?? c.actions[0]?.id ?? null) : null);
  }

  // The cluster the detail pane is actually showing (the selected task, else
  // the first live one — legacy's own fallback).
  function selectedCluster(): TaskCluster | null {
    return clusters.find((c) => taskKey(c) === selectedTaskId) || clusters[0] || null;
  }

  // Master-list display order = the keyboard order: tier sections A→D (each
  // in backend rank order), then the unranked catch-all.
  const tiered = TIERS.map((t) => clusters.filter((c) => c.plan?.tier === t.tier));
  const unranked = clusters.filter((c) => !c.plan);
  const masterKeys = [...tiered.flat(), ...unranked].map(taskKey);

  function moveSelection(delta: number) {
    if (!masterKeys.length) return;
    const idx = masterKeys.indexOf(selectedTaskId ?? "");
    const next = idx < 0 ? 0 : Math.min(masterKeys.length - 1, Math.max(0, idx + delta));
    const key = masterKeys[next];
    if (key != null) selectTask(key);
  }

  // a/e/s act on the SELECTED task — the same cards the detail footer's
  // buttons target (approve/edit → readyCard, skip → skipTarget).
  function keyboardAction(act: "approve" | "edit" | "skip") {
    const c = selectedCluster();
    if (!c) return;
    const { readyCard, skipTarget } = footerTargets(c);
    if (act === "skip") {
      if (!skipTarget) return;
      setSelectedId(skipTarget.id);
      void doAction("skip", undefined, skipTarget.id);
      return;
    }
    if (!readyCard) return;
    setSelectedId(readyCard.id);
    if (act === "edit") {
      // Mirror the Edit-button click: drill into the single-card editor.
      if (readyCard.draft == null) return;
      setEditCardId(readyCard.id);
      setEditing(true);
    } else {
      void doAction("approve", undefined, readyCard.id);
    }
  }

  // Task-level keyboard control. Registered without a dep array so the
  // handler always closes over the CURRENT selection/state — the React
  // equivalent of legacy re-wiring onclick handlers after every render.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // No shortcuts while typing — legacy checked e.target the same way.
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
      const k = e.key;
      // Escape exits draft-edit mode (the help sheet close lives in App).
      if (k === "Escape") {
        setEditing(false);
        return;
      }
      if (k === "j") {
        e.preventDefault();
        moveSelection(1);
      } else if (k === "k") {
        e.preventDefault();
        moveSelection(-1);
      } else if (k === "a") keyboardAction("approve");
      else if (k === "e") keyboardAction("edit");
      else if (k === "s") keyboardAction("skip");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Every clickable action goes through here, exactly like legacy doAction:
  // the button's data-id becomes the selected card, then the action runs.
  function handleAct(act: string, id: string, arg?: string) {
    setSelectedId(id);
    void doAction(act, arg, id);
  }

  async function doAction(act: string, arg: string | undefined, id: string) {
    try {
      if (act === "approve") {
        // If the draft was edited but not yet Saved, persist the textarea
        // first so we send the EDITED text — not the stale server-side draft.
        // This edit-then-approve ORDER is load-bearing (legacy doAction).
        if (editing) {
          const ta = draftRef.current;
          if (ta) {
            await apiPost(`/api/actions/${encodeURIComponent(id)}/edit`, { draft: ta.value });
            setEditing(false);
          }
        }
        const res = await apiPost<ApproveResult>(`/api/actions/${encodeURIComponent(id)}/approve`, {});
        if (!res.ok && res.conflicts) {
          toast(`Conflict with ${res.conflicts.length} event(s) — pick another time`, true);
        } else if (res.awaitingManual) {
          toast("Draft created — awaiting your send");
        } else {
          animateApprove(id);
          toast("Sent");
        }
        setSelectedId(null);
        setEditCardId(null); // return to the task view
        await refresh();
        setRemovingKey(null);
      } else if (act === "edit") {
        setEditing(true);
      } else if (act === "save-edit") {
        const ta = draftRef.current;
        await apiPost(`/api/actions/${encodeURIComponent(id)}/edit`, { draft: ta?.value });
        setEditing(false);
        await refresh();
        setSelectedId(id);
      } else if (act === "skip") {
        // P0: skipping asks WHY — one click on a reason completes the skip.
        setSkipFields([]);
        setSkipFor(id);
      } else if (act === "skip-reason") {
        const existence = arg;
        const idx = selectableIds(allClusters).indexOf(id);
        await apiPost(`/api/actions/${encodeURIComponent(id)}/skip`, {
          existence,
          field_errors: skipFields,
        });
        setSkipFor(null);
        // Select the card that took the skipped one's place. `refresh`
        // returns the fresh payload — the `state` binding here is still the
        // pre-skip snapshot.
        const fresh = await refresh();
        const next = fresh ? selectableIds(fresh.clusters ?? []) : [];
        setSelectedId(next.length ? (next[Math.min(idx, next.length - 1)] ?? null) : null);
        setEditCardId(null); // return to the task view
      } else if (act === "skip-cancel") {
        setSkipFor(null);
      } else if (act === "mark-sent") {
        await apiPost(`/api/actions/${encodeURIComponent(id)}/mark-sent`, {});
        setSelectedId(null);
        await refresh();
        toast("Marked sent");
      } else if (act === "done") {
        // A Me · reminder sub-action (task/ignore): executed with a local
        // receipt, no send, no missing-info gate.
        await apiPost(`/api/actions/${encodeURIComponent(id)}/done`, {});
        setSelectedId(null);
        setEditCardId(null);
        await refresh();
        toast("Marked done");
      } else if (act === "copy") {
        const a = allLiveActions(allClusters).find(({ action }) => action.id === id)?.action;
        if (a && a.draft) {
          await navigator.clipboard.writeText(a.draft);
          toast("Copied — paste into WeChat");
        }
      }
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  async function setTaskTier(key: string, tier: string) {
    try {
      await apiPost(`/api/tasks/${encodeURIComponent(key)}/tier`, { tier });
      setSelectedTaskId(key); // keep it selected after it moves
      await refresh();
      toast(`Moved to ${tier}`);
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  async function restore(id: string) {
    try {
      await apiPost(`/api/actions/${encodeURIComponent(id)}/restore`, {});
      await refresh();
      toast("Restored to queue");
    } catch (e) {
      toast(errMsg(e), true);
    }
  }

  // Approve slide-out: flag the acted card's task so its master-list card
  // gets .removing for the duration of the refresh (see index.css).
  function animateApprove(id: string) {
    const c = clusters.find((cl) => cl.actions.some((a) => a.id === id));
    if (c) setRemovingKey(taskKey(c));
  }

  // ─── render pieces (function-call style, per the header comment) ──

  // One task card in the Today list.
  function renderTaskCard(c: TaskCluster, tierMeta: (typeof TIERS)[number] | null) {
    const key = taskKey(c);
    const selected = key === selectedTaskId && !editCardId;
    const title = c.title || (c.actions[0] && (c.actions[0].headline || c.actions[0].reason)) || "Task";
    const why = c.plan?.why || "";
    const proj = c.actions.find((a) => a.project_id && a.project_id !== "MISC")?.project_id;
    // Status tag from the members: needs-info > awaiting > ready > brief.
    const anyNeeds = c.actions.some((a) => a.status === "suggested" && a.missing_info && a.missing_info.length);
    const anyAwait = c.actions.some((a) => a.status === "approved");
    const anyReady = c.actions.some(
      (a) => a.status === "suggested" && !(a.missing_info && a.missing_info.length),
    );
    const tag = anyNeeds
      ? { t: "Needs info", cls: "text-amber-600 bg-amber-50 dark:bg-amber-950" }
      : anyAwait
        ? { t: "Awaiting", cls: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950" }
        : anyReady
          ? { t: "Ready", cls: "text-primary bg-primary/10" }
          : { t: "Brief", cls: "text-on-surface-variant bg-surface-variant" };
    const leftBorder = tierMeta
      ? { A: "border-l-red-500", B: "border-l-amber-500", C: "border-l-primary", D: "border-l-slate-400" }[
          tierMeta.tier
        ]
      : "border-l-slate-300";
    return (
      <div
        key={key}
        ref={(el) => {
          if (el) cardRefs.current.set(key, el);
          else cardRefs.current.delete(key);
        }}
        data-task={key}
        draggable
        onClick={() => selectTask(key)}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", key);
          e.dataTransfer.effectAllowed = "move";
          setDragKey(key);
        }}
        onDragEnd={() => setDragKey(null)}
        className={cn(
          "task-card relative border border-l-[3px] rounded-xl p-4 cursor-pointer",
          leftBorder,
          // Legacy's selected card + drop highlight used hard-coded blue-50;
          // the semantic equivalent is primary/10 (tracks the theme).
          selected ? "bg-primary/10 border-primary/40" : "bg-surface border-outline hover:bg-surface-variant",
          dragKey === key && "opacity-40",
          removingKey === key && "removing",
        )}
      >
        <div className="flex justify-between items-start gap-2 mb-1.5">
          {proj ? (
            <span className="text-[11px] font-mono text-on-surface-variant bg-surface-variant px-2 py-0.5 rounded">
              {proj}
            </span>
          ) : (
            <span />
          )}
          <span className={cn("text-label-xs uppercase tracking-wide px-2 py-0.5 rounded flex-shrink-0", tag.cls)}>
            {tag.t}
          </span>
        </div>
        <h3 className={cn("text-body-medium text-on-surface font-medium mb-1", isChinese(title) && "font-chinese")}>
          {title}
        </h3>
        {why && (
          <p
            className={cn(
              "text-on-surface-variant text-label-sm line-clamp-2 mb-2",
              isChinese(why) && "font-chinese",
            )}
          >
            {why}
          </p>
        )}
        <div className="flex items-center justify-between text-on-surface-variant text-label-xs">
          <div className="flex items-center gap-1">
            <ListChecks size={14} strokeWidth={1.75} />
            <span>
              {c.done}/{c.total} steps
            </span>
          </div>
          <div className="flex items-center gap-1" title="AI last updated this card">
            <RefreshCw size={14} strokeWidth={1.75} />
            <span>Updated {timeAgo(clusterRecency(c))}</span>
          </div>
        </div>
      </div>
    );
  }

  // Provenance div (empty string → nothing, like legacy).
  function renderProvenance(a: QueueAction) {
    const line = provenanceLine(a);
    if (!line) return null;
    return <div className="text-label-sm text-on-surface-variant mb-4">{line}</div>;
  }

  // One resolution-plan row (a task's member card as a sub-action).
  function subActionRow(a: QueueAction) {
    const needs = !!(a.missing_info && a.missing_info.length > 0);
    const done = a.status === "executed";
    const approved = a.status === "approved";
    const text = a.headline || (a.params && a.params.title) || a.reason || a.action_type;
    const ex = execLabel(a);
    const checked = done || approved;
    let control: React.ReactNode;
    if (done) {
      control = (
        <span className="text-label-xs text-on-surface-variant flex items-center gap-1">
          <CheckCheck size={14} strokeWidth={1.75} />
          {ex.assignee === "ai" ? "AI" : "Me"}
        </span>
      );
    } else if (approved) {
      control = (
        <span className="text-label-xs text-emerald-600 flex items-center gap-1">
          <MailOpen size={14} strokeWidth={1.75} />
          Awaiting your send
        </span>
      );
    } else if (ex.assignee === "me") {
      control = (
        <span className="text-label-xs text-on-surface-variant flex items-center gap-1 bg-surface-variant px-2 py-1 rounded">
          <User size={14} strokeWidth={1.75} />
          Me · reminder
        </span>
      );
    } else if (needs) {
      control = (
        <span className="text-label-xs text-amber-600 flex items-center gap-1 bg-amber-50 dark:bg-amber-950 px-2 py-1 rounded">
          <CircleHelp size={14} strokeWidth={1.75} />
          Needs info
        </span>
      );
    } else {
      control = (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="approve-sub text-label-xs text-white bg-primary hover:bg-blue-700 px-2.5 py-1 rounded flex items-center gap-1"
            onClick={(e) => {
              e.stopPropagation();
              handleAct("approve", a.id);
            }}
          >
            {(() => {
              const Icon = ex.icon;
              return <Icon size={14} strokeWidth={1.75} />;
            })()}
            AI · {ex.label}
          </button>
          {a.draft != null && (
            <button
              type="button"
              className="text-label-xs text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                handleEdit(a.id);
              }}
            >
              Edit
            </button>
          )}
        </div>
      );
    }
    // A "Me · reminder" (task/ignore) row completes with NO side effect, so
    // its circle is a real button: click → mark done. Send-type rows use
    // their button instead; done/approved rows show a static state.
    const checkable = !done && !approved && ex.assignee === "me";
    const circle = checkable ? (
      <button
        type="button"
        className="mt-0.5 text-on-surface-variant hover:text-primary transition-colors"
        title="Mark done"
        onClick={(e) => {
          e.stopPropagation();
          handleAct("done", a.id);
        }}
      >
        <Circle size={20} strokeWidth={1.75} />
      </button>
    ) : (
      <span className={cn("mt-0.5 inline-flex", checked ? "text-primary" : "text-on-surface-variant")}>
        {checked ? <CircleCheck size={20} strokeWidth={1.75} /> : <Circle size={20} strokeWidth={1.75} />}
      </span>
    );
    // Per-row skip: a task with several sub-actions must let you drop ONE of
    // them, not just whichever the footer happens to target.
    const rowSkip =
      a.status === "suggested" ? (
        <button
          type="button"
          className="text-label-xs text-on-surface-variant hover:text-on-surface flex-shrink-0"
          title="Skip just this one (asks why)"
          onClick={(e) => {
            e.stopPropagation();
            handleAct("skip", a.id);
          }}
        >
          Skip
        </button>
      ) : null;
    return (
      <div key={a.id} className={cn("flex items-start gap-3 p-4 bg-surface border border-outline rounded-xl", done && "opacity-60")}>
        {circle}
        <div className="flex-1 min-w-0">
          <p
            className={cn(
              "text-body-medium",
              done ? "text-on-surface-variant line-through" : "text-on-surface",
              isChinese(text) && "font-chinese",
            )}
          >
            {text}
          </p>
          {renderProvenance(a)}
          {a.context?.original_message && (
            <details className="mb-2">
              <summary className="text-label-xs text-on-surface-variant cursor-pointer select-none">
                Show original
              </summary>
              <p
                className={cn(
                  "mt-1 text-label-sm text-on-surface-variant whitespace-pre-wrap border-l-2 border-outline pl-2",
                  isChinese(a.context.original_message) && "font-chinese",
                )}
              >
                {a.context.original_message}
              </p>
            </details>
          )}
          <div className="mt-2">{control}</div>
        </div>
        {rowSkip}
      </div>
    );
  }

  function renderEntityCard(e: TaskEntity, i: number) {
    const icon = ENTITY_ICON[e.kind] || "🔖";
    return (
      <div key={i} className="bg-surface border border-outline rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">{icon}</span>
          <span className={cn("text-body-medium text-on-surface font-medium truncate", isChinese(e.label) && "font-chinese")}>
            {e.label}
          </span>
        </div>
        {e.value && (
          <p className={cn("text-body-base text-on-surface", isChinese(e.value) && "font-chinese")}>{e.value}</p>
        )}
        {e.source && (
          <p className={cn("text-label-xs text-on-surface-variant mt-1 truncate", isChinese(e.source) && "font-chinese")}>
            {e.source}
          </p>
        )}
      </div>
    );
  }

  // The skip-reason panel: one click on a reason completes the skip.
  function skipReasonPanel(id: string) {
    return (
      <div className="bg-surface border border-outline rounded-xl px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-label-sm text-on-surface-variant uppercase tracking-wider">
            Why are you skipping? (one click completes it)
          </span>
          <button
            type="button"
            className="text-label-sm text-on-surface-variant hover:text-on-surface"
            onClick={() => handleAct("skip-cancel", id)}
          >
            Cancel
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          {SKIP_REASONS.map((r) => (
            <button
              key={r.key}
              type="button"
              className="text-body-base px-3 py-1.5 rounded-lg border border-outline hover:bg-primary/10 hover:border-primary/40 text-on-surface"
              title={r.hint || undefined}
              onClick={() => handleAct("skip-reason", id, r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-label-sm text-on-surface-variant border-t border-outline pt-3">
          <span>Also flag wrong fields (optional):</span>
          {SKIP_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center gap-1 cursor-pointer hover:text-on-surface">
              <input
                type="checkbox"
                className="skip-field"
                value={f.key}
                checked={skipFields.includes(f.key)}
                onChange={() =>
                  setSkipFields((prev) => (prev.includes(f.key) ? prev.filter((k) => k !== f.key) : [...prev, f.key]))
                }
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  function renderTaskDetail(c: TaskCluster) {
    const title = c.title || (c.actions[0] && (c.actions[0].headline || c.actions[0].reason)) || "Task";
    const plan: TaskPlan | undefined = c.plan;
    const tierMeta = plan
      ? {
          A: { cls: "text-red-600 bg-red-50 dark:bg-red-950", dot: "bg-red-500", label: "A · Do first" },
          B: { cls: "text-amber-600 bg-amber-50 dark:bg-amber-950", dot: "bg-amber-500", label: "B · Today" },
          C: { cls: "text-primary bg-primary/10", dot: "bg-primary", label: "C · This week" },
          D: { cls: "text-on-surface-variant bg-surface-variant", dot: "bg-slate-400", label: "D · Later" },
        }[plan.tier]
      : null;
    const proj = c.actions.find((a) => a.project_id && a.project_id !== "MISC")?.project_id;
    // Context = the digest only (the raw thread quote is noise).
    const primary = c.actions.find((a) => a.summary) || c.actions[0];
    const entities = plan?.entities || [];
    const { readyCard, skipTarget } = footerTargets(c);
    // The reason panel belongs to whichever card was clicked — the footer's
    // Skip OR any row's — so a multi-card task can skip a specific sub-action.
    const pendingSkip = skipFor ? c.actions.find((a) => a.id === skipFor) : null;

    return (
      <div className="w-full max-w-[800px]" data-testid="task-detail">
        <header className="mb-6">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            {tierMeta && (
              <span className={cn("flex items-center gap-1.5 text-label-sm px-2.5 py-1 rounded-full uppercase", tierMeta.cls)}>
                <span className={cn("w-1.5 h-1.5 rounded-full", tierMeta.dot)} />
                {tierMeta.label}
              </span>
            )}
            {proj && (
              <span className="text-[11px] font-mono text-on-surface-variant bg-surface-variant px-2.5 py-1 rounded">
                {proj}
              </span>
            )}
            <span
              className="flex items-center gap-1 text-label-xs text-on-surface-variant ml-auto"
              title="AI last updated this card"
            >
              <RefreshCw size={14} strokeWidth={1.75} />
              Updated {timeAgo(clusterRecency(c))}
            </span>
          </div>
          <h1 data-testid="detail-title" className={cn("text-display text-on-surface mb-2", isChinese(title) && "font-chinese")}>
            {title}
          </h1>
          {primary && renderProvenance(primary)}
          {plan?.why && (
            <p
              className={cn(
                "text-body-lg font-medium",
                plan.tier === "A" ? "text-red-600" : "text-on-surface-variant",
                isChinese(plan.why) && "font-chinese",
              )}
            >
              {plan.why}
            </p>
          )}
        </header>

        {primary?.summary && (
          <section className="bg-surface border border-outline rounded-xl p-5 mb-6">
            <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2">
              <Info size={16} strokeWidth={1.75} />
              Context
            </h2>
            <p className={cn("text-body-base text-on-surface leading-relaxed", isChinese(primary.summary) && "font-chinese")}>
              {primary.summary}
            </p>
            {primary.context?.original_message && (
              <details className="mt-3">
                <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">
                  Show original
                </summary>
                <p
                  className={cn(
                    "mt-2 text-body-medium text-on-surface-variant whitespace-pre-wrap border-l-2 border-outline pl-3",
                    isChinese(primary.context.original_message) && "font-chinese",
                  )}
                >
                  {primary.context.original_message}
                </p>
              </details>
            )}
          </section>
        )}

        <section className="mb-6">
          <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2 px-1">
            <CircleCheck size={16} strokeWidth={1.75} />
            Resolution Plan
          </h2>
          <div className="flex flex-col gap-3">{c.actions.map(subActionRow)}</div>
        </section>

        {entities.length > 0 && (
          <section className="mb-6">
            <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2 px-1">
              <Shapes size={16} strokeWidth={1.75} />
              Related Entities
            </h2>
            <div className="grid grid-cols-2 gap-3">{entities.map(renderEntityCard)}</div>
          </section>
        )}

        {pendingSkip ? (
          skipReasonPanel(pendingSkip.id)
        ) : (
          <div className="flex items-center justify-between gap-4 bg-surface border border-outline rounded-xl px-6 py-4">
            <div className="flex gap-4">
              {readyCard ? (
                <>
                  <button
                    type="button"
                    className="bg-primary text-white text-body-medium px-4 py-2 rounded hover:bg-blue-700 flex items-center gap-2"
                    onClick={() => handleAct("approve", readyCard.id)}
                  >
                    {(() => {
                      const Icon = execLabel(readyCard).icon;
                      return <Icon size={18} strokeWidth={1.75} />;
                    })()}
                    {execLabel(readyCard).label}
                  </button>
                  {readyCard.draft != null && (
                    <button
                      type="button"
                      className="bg-surface text-on-surface text-body-medium px-4 py-2 rounded border border-outline hover:bg-surface-variant"
                      onClick={() => handleEdit(readyCard.id)}
                    >
                      Edit
                    </button>
                  )}
                </>
              ) : (
                <span className="text-on-surface-variant text-body-base">
                  Nothing ready to send — review the steps.
                </span>
              )}
            </div>
            {skipTarget && (
              <button
                type="button"
                className="text-on-surface-variant text-body-medium hover:text-on-surface"
                onClick={() => handleAct("skip", skipTarget.id)}
              >
                Skip
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  function handleEdit(id: string) {
    setEditCardId(id);
    setSelectedId(id);
    setEditing(true);
  }

  // The message block: the LLM summary as the digest (sender named), with the
  // raw original tucked behind a "Show original" expander. Legacy rows have
  // no summary → show the original directly.
  function msgBlock(a: QueueAction, sender: string) {
    const orig = a.context?.original_message;
    const card = (inner: React.ReactNode) => (
      <div className="bg-background rounded p-4 border border-outline border-l-4 border-l-slate-300 mb-6">
        <div className="text-label-sm font-bold text-on-surface mb-1">{sender}</div>
        {inner}
      </div>
    );
    if (a.summary) {
      return card(
        <>
          <p className={cn("text-body-base text-on-surface whitespace-pre-wrap", isChinese(a.summary) && "font-chinese")}>
            {a.summary}
          </p>
          {orig && (
            <details className="mt-2">
              <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">
                Show original
              </summary>
              <p className={cn("mt-1 text-body-medium text-on-surface-variant whitespace-pre-wrap", isChinese(orig) && "font-chinese")}>
                {orig}
              </p>
            </details>
          )}
        </>,
      );
    }
    if (orig) {
      return card(
        <p className={cn("text-body-base text-on-surface whitespace-pre-wrap", isChinese(orig) && "font-chinese")}>
          {orig}
        </p>,
      );
    }
    return null;
  }

  // The project this card advances; a MISC/unset card shows a muted chip.
  function projectBadge(a: QueueAction) {
    const pid = a.project_id;
    if (pid && pid !== "MISC") {
      const label = a.project_name || pid;
      return (
        <div className="mb-2">
          <span className={cn("inline-flex items-center gap-1 text-label-sm text-primary bg-primary/10 border border-primary/20 px-2.5 py-1 rounded-lg", isChinese(label) && "font-chinese")}>
            <Folder size={15} strokeWidth={1.75} />
            {label}
          </span>
        </div>
      );
    }
    return (
      <div className="mb-2">
        <span className="inline-flex items-center gap-1 text-label-sm text-on-surface-variant bg-surface-variant px-2.5 py-1 rounded-lg">
          <Inbox size={15} strokeWidth={1.75} />
          Misc
        </span>
      </div>
    );
  }

  // The single-card drill-in (edit mode lives here).
  function renderDetail(a: QueueAction) {
    const needsInfo = !!(a.missing_info && a.missing_info.length > 0);
    const sender = a.sender_name || a.context?.sender_handle || "?";
    const recipient = a.recipient_name || a.target?.personaKey || a.target?.platform || "—";
    const isManual = a.status === "approved";
    const platIcon: LucideIcon =
      { gmail: Mail, slack: Hash, wechat: MessageSquare, calendar: Calendar }[a.target?.platform ?? ""] || Zap;
    const title = a.headline || (a.params && a.params.title) || a.reason || a.action_type;

    const draftBlock =
      a.draft != null ? (
        editing ? (
          <textarea
            id="draft-edit"
            ref={draftRef}
            defaultValue={a.draft}
            className={cn(
              "w-full min-h-[140px] bg-primary/5 rounded-lg p-4 border border-primary/20 text-body-base text-on-surface",
              isChinese(a.draft) && "font-chinese",
            )}
          />
        ) : (
          <div className="relative bg-primary/5 rounded-lg p-4 border border-primary/20">
            <div className="absolute top-2 right-2 bg-surface border border-outline rounded-sm px-2 py-0.5 flex items-center gap-1 text-[10px]">
              <span className="font-bold text-primary">{isChinese(a.draft) ? "中文" : "EN"}</span>
              {a.params?._edited && <span className="text-on-surface-variant">· edited</span>}
            </div>
            <p className={cn("text-body-base text-on-surface pr-16 whitespace-pre-wrap", isChinese(a.draft) && "font-chinese")}>
              {a.draft}
            </p>
          </div>
        )
      ) : null;

    const primaryCls =
      "bg-primary text-white text-body-medium px-4 py-2 rounded hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed";
    const secondaryCls =
      "bg-surface text-on-surface text-body-medium px-4 py-2 rounded border border-outline hover:bg-surface-variant transition-colors";
    let actions: React.ReactNode;
    if (isManual) {
      const isGmail = a.target?.platform === "gmail";
      actions = (
        <div className="px-6 py-4 bg-surface-variant border-y border-outline flex items-center gap-4">
          {isGmail ? (
            <span className="text-body-medium text-on-surface-variant flex-1">
              Draft created — open Gmail to send.
            </span>
          ) : (
            <button type="button" className={cn(secondaryCls, "flex-1")} onClick={() => handleAct("copy", a.id)}>
              Copy
            </button>
          )}
          <button type="button" className={primaryCls} onClick={() => handleAct("mark-sent", a.id)}>
            <Check size={18} strokeWidth={1.75} /> Mark sent
          </button>
        </div>
      );
    } else {
      const approveLabel =
        a.action_type === "reply" || a.action_type === "relay" || a.action_type === "forward" ? (
          <>
            <Send size={18} strokeWidth={1.75} /> Approve &amp; Send
          </>
        ) : (
          "Approve"
        );
      actions = (
        <div className="px-6 py-4 bg-surface-variant border-y border-outline flex items-center justify-between">
          <div className="flex gap-4">
            <button type="button" className={primaryCls} disabled={needsInfo} onClick={() => handleAct("approve", a.id)}>
              {approveLabel}
            </button>
            {editing ? (
              <button type="button" className={secondaryCls} onClick={() => handleAct("save-edit", a.id)}>
                Save
              </button>
            ) : (
              a.draft != null && (
                <button type="button" className={secondaryCls} onClick={() => handleAct("edit", a.id)}>
                  Edit
                </button>
              )
            )}
          </div>
          <button
            type="button"
            className="text-on-surface-variant text-body-medium hover:text-on-surface transition-colors"
            onClick={() => handleAct("skip", a.id)}
          >
            Skip
          </button>
        </div>
      );
    }

    return (
      <div className="bg-surface border border-outline rounded w-full max-w-[800px] h-fit flex flex-col">
        <div className="p-6">
          {needsInfo && (
            <div className="mb-4 bg-amber-50 dark:bg-amber-950 border border-amber-200 rounded p-4 text-label-sm text-amber-700 dark:text-amber-400">
              Needs info:{" "}
              {a.missing_info!.map((m) => (
                <span key={m} className="bg-surface border border-amber-200 rounded-sm px-2 py-0.5 mr-1">
                  {m}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mb-4 text-on-surface-variant">
            <Avatar label={sender} hueKey={sender} />
            <ArrowRight size={16} strokeWidth={1.75} />
            {(() => {
              const Icon = platIcon;
              return <Icon size={16} strokeWidth={1.75} />;
            })()}
            <ArrowRight size={16} strokeWidth={1.75} />
            <Avatar label={String(recipient)} hueKey={String(recipient)} />
            <span className="ml-auto text-label-xs uppercase tracking-wide text-on-surface-variant bg-surface-variant px-2 py-0.5 rounded-xl">
              {a.action_type}
            </span>
          </div>
          {projectBadge(a)}
          <h2 className={cn("text-display mb-4", isChinese(title) && "font-chinese")}>{title}</h2>
          {renderProvenance(a)}
          {msgBlock(a, sender)}
          {a.next_actions && a.next_actions.length > 0 && (
            <div className="mb-6 bg-primary/5 border border-primary/20 rounded-lg p-4">
              <h3 className="text-label-sm text-primary font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Zap size={18} strokeWidth={1.75} /> Action Items
              </h3>
              <ul className="flex flex-col gap-2">
                {a.next_actions.map((t, i) => (
                  <li key={i} className={cn("flex items-start gap-2 text-body-base text-on-surface", isChinese(t) && "font-chinese")}>
                    <ArrowRight size={18} strokeWidth={1.75} className="text-primary flex-shrink-0" />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {draftBlock && (
            <div>
              <h3 className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-2">Draft</h3>
              {draftBlock}
            </div>
          )}
        </div>
        {actions}
      </div>
    );
  }

  // Completed + skipped history drawer: two sections inside one collapsed
  // <details>. Restore is offered only when undo is safe (local receipts and
  // no-receipt rows, never a real sent/calendar_event side effect).
  function renderDrawer() {
    if (!state) return null;
    const done = state.done ?? [];
    const skipped = state.skipped ?? [];
    if (!done.length && !skipped.length) return null;
    const rowTitle = (a: QueueAction) => a.headline || (a.params && a.params.title) || a.summary || a.reason || a.action_type;
    const row = (a: QueueAction, tail: React.ReactNode) => {
      const t = rowTitle(a);
      return (
        <div key={a.id} className="flex items-center gap-2 py-1.5 text-label-sm">
          <span className="text-on-surface-variant uppercase tracking-wide text-[10px] flex-shrink-0">
            {a.action_type}
          </span>
          <span className={cn("text-on-surface-variant truncate flex-1", isChinese(t) && "font-chinese")} title={t}>
            {t}
          </span>
          {tail}
        </div>
      );
    };
    const restoreBtn = (a: QueueAction) => (
      <button
        type="button"
        className="text-primary hover:underline flex-shrink-0"
        onClick={() => void restore(a.id)}
      >
        Restore
      </button>
    );
    const DONE_CAP = 50;
    const doneShown = done.slice(-DONE_CAP).reverse(); // newest first
    const doneRows = doneShown.map((a) => {
      const receipt = a.params?.execution_receipt;
      const restorable = !receipt || receipt.kind === "local";
      const when = receipt?.at ? new Date(receipt.at) : null;
      return row(
        a,
        <>
          {when && !isNaN(when.getTime()) && (
            <span className="text-on-surface-variant flex-shrink-0">{fmtWhen(when)}</span>
          )}
          {restorable && restoreBtn(a)}
        </>,
      );
    });
    return (
      <details className="mt-6 border-t border-outline pt-2">
        <summary className="text-label-sm text-on-surface-variant cursor-pointer select-none">
          Completed ({done.length}) · Skipped ({skipped.length})
        </summary>
        {done.length > 0 && (
          <div className="mt-2">
            <div className="text-label-sm text-on-surface-variant uppercase tracking-wide mb-1">Completed</div>
            {doneRows}
            {done.length > DONE_CAP && (
              <div className="py-1.5 text-label-sm text-on-surface-variant">…and {done.length - DONE_CAP} more</div>
            )}
          </div>
        )}
        {skipped.length > 0 && (
          <div className="mt-2">
            <div className="text-label-sm text-on-surface-variant uppercase tracking-wide mb-1">Skipped</div>
            {skipped.map((a) => row(a, restoreBtn(a)))}
          </div>
        )}
      </details>
    );
  }

  // ─── screen layout ────────────────────────────────────────────────

  const attention = clusters.filter((c) => ["A", "B"].includes(c.plan?.tier ?? "")).length;
  const header = (
    <header className="p-6 pb-4 border-b border-outline flex-shrink-0">
      <h1 className="text-headline text-on-surface">Today</h1>
      <p className="text-on-surface-variant text-body-base mt-1">
        {attention} item{attention === 1 ? "" : "s"} requiring attention · {clusters.length} task
        {clusters.length === 1 ? "" : "s"}
      </p>
    </header>
  );

  if (state && clusters.length === 0) {
    return (
      <>
        {header}
        <div className="flex-1 flex flex-col items-center justify-center text-on-surface-variant gap-1">
          <div className="text-display text-on-surface">All handled.</div>
          <div className="text-body-base">
            {(state.done ?? []).length} auto-handled · {(state.skipped ?? []).length} skipped
          </div>
          <div className="w-full max-w-[440px] mt-6 px-4">{renderDrawer()}</div>
        </div>
      </>
    );
  }

  // Detail: an Edit drill-in shows the single-card editor; else the task view.
  let detail: React.ReactNode;
  if (editCardId) {
    const card = allLiveActions(allClusters).find(({ action }) => action.id === editCardId)?.action;
    detail = card ? (
      <div className="w-full max-w-[800px]">
        <button
          type="button"
          className="text-label-sm text-primary mb-2 flex items-center gap-1"
          onClick={() => {
            setEditCardId(null);
            setEditing(false);
          }}
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
          Back to task
        </button>
        {renderDetail(card)}
      </div>
    ) : (
      <div className="text-on-surface-variant">Card gone.</div>
    );
  } else {
    const sel = selectedCluster();
    detail = sel ? (
      renderTaskDetail(sel)
    ) : (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-body-base">
        Select a task.
      </div>
    );
  }

  return (
    <>
      {header}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-[400px] flex-shrink-0 border-r border-outline bg-surface overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-4">
          {TIERS.map((t, i) => (
            <section key={t.tier} className="mb-6">
              <div className="flex items-center gap-2 mb-3 px-1">
                <div className={cn("w-2 h-2 rounded-full", t.dot)} />
                <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider">{t.label}</h2>
              </div>
              {/* All four tiers render (even empty) so every one is a drop
                  target — drag a mis-ranked card into another section. */}
              <div
                data-drop-tier={t.tier}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropTier(t.tier);
                }}
                onDragLeave={() => setDropTier(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTier(null);
                  const key = e.dataTransfer.getData("text/plain");
                  if (key) void setTaskTier(key, t.tier);
                }}
                className={cn(
                  "flex flex-col gap-2 rounded-lg p-1 -m-1 transition-colors",
                  dropTier === t.tier && "bg-primary/10 ring-1 ring-primary/40",
                )}
              >
                {tiered[i]!.length ? (
                  tiered[i]!.map((c) => renderTaskCard(c, t))
                ) : (
                  <div className="text-label-xs text-on-surface-variant/50 italic px-1 py-2">drop here</div>
                )}
              </div>
            </section>
          ))}
          {unranked.length > 0 && (
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-3 px-1">
                <div className="w-2 h-2 rounded-full bg-slate-300" />
                <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wider">Unranked</h2>
              </div>
              <div className="flex flex-col gap-2">{unranked.map((c) => renderTaskCard(c, null))}</div>
            </section>
          )}
          <div className="pt-2">{renderDrawer()}</div>
        </div>
        <div className="flex-1 bg-background overflow-y-auto flex justify-center p-6">{detail}</div>
      </div>
    </>
  );
}
