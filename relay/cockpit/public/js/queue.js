// queue.js — the Today screen (specs/daily-todo.md): the tiered master list
// of task clusters (A→D + Unranked), the task detail with its resolution plan,
// the typed-skip reason picker, drag-to-re-tier, and the task-level keyboard
// control (j/k move, a/e/s act). Renders HTML strings; render()/refresh() it
// triggers live in main.js — a deliberate circular import resolved through
// ES-module live bindings (the calls only ever happen at runtime, never
// during module evaluation).

import { App, avatar, escapeHtml, isChinese, timeAgo, toast } from "./state.js";
import { apiPost } from "./api.js";
import { refresh, render } from "./main.js";

// A cluster's recency = its newest member's created_at (ISO strings sort
// lexically). Used to order the master list newest-first.
function clusterRecency(c) {
  let max = "";
  for (const a of c.actions) if (a.created_at > max) max = a.created_at;
  return max;
}
// Clusters newest-first. The SINGLE source of order for the master list AND
// keyboard / skip navigation, so the two never disagree.
function sortedClusters() {
  return [...(App.state?.clusters || [])].sort(
    (a, b) => clusterRecency(b).localeCompare(clusterRecency(a)),
  );
}
function allLiveActions() {
  // flatten clusters → actions in display (newest-first) order
  const out = [];
  for (const c of sortedClusters()) {
    for (const a of c.actions) out.push({ action: a, cluster: c });
  }
  return out;
}
function selectableIds() {
  return allLiveActions()
    .filter(({ action }) => action.status === "suggested")
    .map(({ action }) => action.id);
}

// A task cluster's unit key — computed by the backend (api getState attaches
// `unit_key`; core/unit-key.ts keeps it stable across supersede). The old
// id-based derivation stays only as a fallback for stale cached state.
function taskKey(c) {
  return c.unit_key || c.task_id || (c.actions[0] ? `__ungrouped_${c.actions[0].id}` : "");
}
// Live task clusters (those with a suggested/approved member).
function liveClusters() {
  return (App.state?.clusters || []).filter((c) =>
    c.actions.some((a) => a.status === "suggested" || a.status === "approved"),
  );
}
const TIERS = [
  { tier: "A", label: "A · Do first", dot: "bg-red-500" },
  { tier: "B", label: "B · Today", dot: "bg-amber-500" },
  { tier: "C", label: "C · This week", dot: "bg-primary" },
  { tier: "D", label: "D · Later", dot: "bg-slate-400" },
];

// Today — the prioritized daily to-do (specs/daily-todo.md).
export function renderQueue() {
  const s = App.state;
  // MUTED (per user): the sourceErrors notices — a source that couldn't be reached
  // (cursor frozen) or an LLM step that timed out (self-retries) — are all non-fatal
  // and self-healing ("nothing lost"), so they no longer render as queue banners.
  // A genuine outage still surfaces in the People screen's connection status.
  const clusters = liveClusters();
  const attention = clusters.filter((c) => ["A", "B"].includes(c.plan?.tier)).length;

  // Master list: tier sections A→D + an "Unranked" catch-all (plans not computed yet).
  // All four tiers render (even empty) so every one is a drop target — drag a
  // mis-ranked card into another section.
  let master = "";
  for (const t of TIERS) {
    const inTier = clusters.filter((c) => c.plan?.tier === t.tier);
    const cards = inTier.length
      ? inTier.map((c) => renderTaskCard(c, t)).join("")
      : `<div class="text-label-xs text-on-surface-variant/50 italic px-1 py-2">drop here</div>`;
    master += `
      <section class="mb-6">
        <div class="flex items-center gap-2 mb-3 px-1">
          <div class="w-2 h-2 rounded-full ${t.dot}"></div>
          <h2 class="text-label-sm text-on-surface-variant uppercase tracking-wider">${t.label}</h2>
        </div>
        <div class="drop-tier flex flex-col gap-sm rounded-lg p-1 -m-1 transition-colors" data-drop-tier="${t.tier}">${cards}</div>
      </section>`;
  }
  const unranked = clusters.filter((c) => !c.plan);
  if (unranked.length) {
    master += `
      <section class="mb-6">
        <div class="flex items-center gap-2 mb-3 px-1">
          <div class="w-2 h-2 rounded-full bg-slate-300"></div>
          <h2 class="text-label-sm text-on-surface-variant uppercase tracking-wider">Unranked</h2>
        </div>
        <div class="flex flex-col gap-sm">${unranked.map((c) => renderTaskCard(c, null)).join("")}</div>
      </section>`;
  }
  master += `<div class="pt-2">${renderDrawer()}</div>`;

  const top = `
    <header class="p-lg pb-4 border-b border-outline flex-shrink-0">
      <h1 class="text-headline text-on-surface">Today</h1>
      <p class="text-on-surface-variant text-body-base mt-1">${attention} item${attention === 1 ? "" : "s"} requiring attention · ${clusters.length} task${clusters.length === 1 ? "" : "s"}</p>
    </header>`;

  if (clusters.length === 0) {
    return `${top}
      <div class="flex-1 flex flex-col items-center justify-center text-on-surface-variant gap-1">
        <div class="text-display text-on-surface">All handled.</div>
        <div class="text-body-base">${s.done.length} auto-handled · ${s.skipped.length} skipped</div>
        <div class="w-full max-w-[440px] mt-lg px-md">${renderDrawer()}</div>
      </div>`;
  }

  // Detail: an Edit drill-in shows the single-card editor; else the task view.
  let detail;
  if (App.editCardId) {
    const card = allLiveActions().find(({ action }) => action.id === App.editCardId)?.action;
    detail = card
      ? `<div class="w-full max-w-[800px]"><button class="back-task text-label-sm text-primary mb-sm flex items-center gap-1"><span class="material-symbols-outlined text-[16px]">arrow_back</span>Back to task</button>${renderDetail(card)}</div>`
      : `<div class="text-on-surface-variant">Card gone.</div>`;
  } else {
    const sel = clusters.find((c) => taskKey(c) === App.selectedTaskId) || clusters[0];
    detail = sel
      ? renderTaskDetail(sel)
      : `<div class="flex-1 flex items-center justify-center text-on-surface-variant text-body-base">Select a task.</div>`;
  }

  return `${top}
    <div class="flex-1 flex overflow-hidden">
      <div class="master w-[400px] flex-shrink-0 border-r border-outline bg-surface overflow-y-auto hide-scrollbar p-4">${master}</div>
      <div class="flex-1 bg-background overflow-y-auto flex justify-center p-lg">${detail}</div>
    </div>`;
}

// One task card in the Today list.
function renderTaskCard(c, tierMeta) {
  const key = taskKey(c);
  const selected = key === App.selectedTaskId && !App.editCardId;
  const title = c.title || (c.actions[0] && (c.actions[0].headline || c.actions[0].reason)) || "Task";
  const why = c.plan?.why || "";
  const proj = c.actions.find((a) => a.project_id && a.project_id !== "MISC")?.project_id;
  // Status tag from the members: needs-info > awaiting > ready > brief.
  const anyNeeds = c.actions.some((a) => a.status === "suggested" && a.missing_info && a.missing_info.length);
  const anyAwait = c.actions.some((a) => a.status === "approved");
  const anyReady = c.actions.some((a) => a.status === "suggested" && !(a.missing_info && a.missing_info.length));
  const tag = anyNeeds ? { t: "Needs info", cls: "text-amber-600 bg-amber-50" }
    : anyAwait ? { t: "Awaiting", cls: "text-emerald-600 bg-emerald-50" }
    : anyReady ? { t: "Ready", cls: "text-primary bg-primary/10" }
    : { t: "Brief", cls: "text-on-surface-variant bg-surface-variant" };
  const leftBorder = tierMeta ? { A: "border-l-red-500", B: "border-l-amber-500", C: "border-l-primary", D: "border-l-slate-400" }[tierMeta.tier] : "border-l-slate-300";
  const base = selected
    ? "bg-blue-50 border-primary/40"
    : "bg-surface border-outline hover:bg-slate-50";
  return `
    <div class="task-card relative border border-l-[3px] ${leftBorder} ${base} rounded-xl p-4 cursor-pointer transition-colors" draggable="true" data-task="${escapeHtml(key)}">
      <div class="flex justify-between items-start gap-2 mb-1.5">
        ${proj ? `<span class="text-[11px] font-mono text-on-surface-variant bg-surface-variant px-2 py-0.5 rounded">${escapeHtml(proj)}</span>` : "<span></span>"}
        <span class="text-label-xs uppercase tracking-wide px-2 py-0.5 rounded ${tag.cls} flex-shrink-0">${tag.t}</span>
      </div>
      <h3 class="text-body-medium text-on-surface font-medium mb-1 ${isChinese(title) ? "font-chinese" : ""}">${escapeHtml(title)}</h3>
      ${why ? `<p class="text-on-surface-variant text-label-sm line-clamp-2 mb-2 ${isChinese(why) ? "font-chinese" : ""}">${escapeHtml(why)}</p>` : ""}
      <div class="flex items-center justify-between text-on-surface-variant text-label-xs">
        <div class="flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">checklist</span><span>${c.done}/${c.total} steps</span></div>
        <div class="flex items-center gap-1" title="AI last updated this card"><span class="material-symbols-outlined text-[14px]">update</span><span>Updated ${escapeHtml(timeAgo(clusterRecency(c)))}</span></div>
      </div>
    </div>`;
}

// AI-executable action types + the one-click button label (per platform).
function execLabel(a) {
  if (a.action_type === "calendar") return { assignee: "ai", label: "Create event", icon: "event" };
  if (a.action_type === "reply" || a.action_type === "relay" || a.action_type === "forward") {
    return a.target?.platform === "gmail"
      ? { assignee: "ai", label: "Prepare draft", icon: "edit_document" }
      : { assignee: "ai", label: "Approve & Send", icon: "send" };
  }
  return { assignee: "me", label: null, icon: "person" }; // task / ignore → Me reminder
}

// One resolution-plan row (a task's member card as a sub-action).
function subActionRow(a) {
  const needs = a.missing_info && a.missing_info.length > 0;
  const done = a.status === "executed";
  const approved = a.status === "approved";
  const text = a.headline || (a.params && a.params.title) || a.reason || a.action_type;
  const ex = execLabel(a);
  const checked = done || approved ? "checked" : "";
  const dim = done ? "opacity-60" : "";
  const textCls = done ? "text-on-surface-variant line-through" : "text-on-surface";
  let control;
  if (done) control = `<span class="text-label-xs text-on-surface-variant flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">done_all</span>${ex.assignee === "ai" ? "AI" : "Me"}</span>`;
  else if (approved) control = `<span class="text-label-xs text-emerald-600 flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">drafts</span>Awaiting your send</span>`;
  else if (ex.assignee === "me") control = `<span class="text-label-xs text-on-surface-variant flex items-center gap-1 bg-surface-variant px-2 py-1 rounded"><span class="material-symbols-outlined text-[14px]">person</span>Me · reminder</span>`;
  else if (needs) control = `<span class="text-label-xs text-amber-600 flex items-center gap-1 bg-amber-50 px-2 py-1 rounded"><span class="material-symbols-outlined text-[14px]">help</span>Needs info</span>`;
  else control = `<div class="flex items-center gap-2">
      <button class="approve-sub text-label-xs text-white bg-primary hover:bg-blue-700 px-2.5 py-1 rounded flex items-center gap-1" data-act="approve" data-id="${escapeHtml(a.id)}"><span class="material-symbols-outlined text-[14px]">${ex.icon}</span>AI · ${ex.label}</button>
      ${a.draft != null ? `<button class="text-label-xs text-primary hover:underline" data-edit="${escapeHtml(a.id)}">Edit</button>` : ""}
    </div>`;
  // A "Me · reminder" (task/ignore) row completes with NO side effect, so its
  // circle is a real checkbox: click → mark done (approve → executed). Send-type
  // rows use their button instead; done/approved rows show a static state.
  const checkable = !done && !approved && ex.assignee === "me";
  const circle = checkable
    ? `<button class="check-done mt-0.5 text-on-surface-variant hover:text-primary transition-colors" data-act="done" data-id="${escapeHtml(a.id)}" title="Mark done"><span class="material-symbols-outlined text-[20px]">radio_button_unchecked</span></button>`
    : `<span class="material-symbols-outlined text-[20px] mt-0.5 ${checked ? "text-primary" : "text-on-surface-variant"}">${checked ? "check_circle" : "radio_button_unchecked"}</span>`;
  // Per-row skip: a task with several sub-actions must let you drop ONE of them,
  // not just whichever the footer happens to target.
  const rowSkip = a.status === "suggested"
    ? `<button class="text-label-xs text-on-surface-variant hover:text-on-surface flex-shrink-0" data-act="skip" data-id="${escapeHtml(a.id)}" title="跳过这一条(会问原因)">跳过</button>`
    : "";
  return `
    <div class="flex items-start gap-3 p-4 bg-surface border border-outline rounded-xl ${dim}">
      ${circle}
      <div class="flex-1 min-w-0">
        <p class="text-body-medium ${textCls} ${isChinese(text) ? "font-chinese" : ""}">${escapeHtml(text)}</p>
        <div class="mt-2">${control}</div>
      </div>
      ${rowSkip}
    </div>`;
}

const ENTITY_ICON = { flight: "✈️", file: "📄", price: "💰", confirmation: "🏨", deadline: "📅", person: "👤", doc: "📝" };
function entityCard(e) {
  const icon = ENTITY_ICON[e.kind] || "🔖";
  return `
    <div class="bg-surface border border-outline rounded-xl p-4 hover:shadow-sm transition-shadow">
      <div class="flex items-center gap-2 mb-1"><span class="text-lg">${icon}</span><span class="text-body-medium text-on-surface font-medium truncate ${isChinese(e.label) ? "font-chinese" : ""}">${escapeHtml(e.label)}</span></div>
      ${e.value ? `<p class="text-body-base text-on-surface ${isChinese(e.value) ? "font-chinese" : ""}">${escapeHtml(e.value)}</p>` : ""}
      ${e.source ? `<p class="text-label-xs text-on-surface-variant mt-1 truncate ${isChinese(e.source) ? "font-chinese" : ""}">${escapeHtml(e.source)}</p>` : ""}
    </div>`;
}

// The detail footer's own targeting, extracted so the keyboard shortcuts hit
// exactly the cards the on-screen buttons would: approve/edit → readyCard
// (footer primary), skip → skipTarget (footer Skip).
function footerTargets(c) {
  // Footer primary = first ready AI-executable suggested card.
  const readyCard = c.actions.find((a) => a.status === "suggested" && !(a.missing_info && a.missing_info.length) && execLabel(a).assignee === "ai");
  // Skip must work on ANY still-suggested card, not only AI-sendable ones. Gating
  // it on readyCard left `Me · reminder` (task) and `Needs info` cards with no way
  // to skip at all — and `task` is the highest-volume, lowest-precision type
  // (126 decided, 0.444), i.e. exactly where the reason signal matters most.
  const skipTarget = readyCard || c.actions.find((a) => a.status === "suggested");
  return { readyCard, skipTarget };
}

function renderTaskDetail(c) {
  const title = c.title || (c.actions[0] && (c.actions[0].headline || c.actions[0].reason)) || "Task";
  const plan = c.plan;
  const tierMeta = plan ? { A: { cls: "text-red-600 bg-red-50", dot: "bg-red-500", label: "A · Do first" }, B: { cls: "text-amber-600 bg-amber-50", dot: "bg-amber-500", label: "B · Today" }, C: { cls: "text-primary bg-primary/10", dot: "bg-primary", label: "C · This week" }, D: { cls: "text-on-surface-variant bg-surface-variant", dot: "bg-slate-400", label: "D · Later" } }[plan.tier] : null;
  const proj = c.actions.find((a) => a.project_id && a.project_id !== "MISC")?.project_id;
  // Context = the digest only (the raw thread quote is noise — see feedback).
  const primary = c.actions.find((a) => a.summary) || c.actions[0] || {};
  const entities = plan?.entities || [];
  const { readyCard, skipTarget } = footerTargets(c);
  // The reason panel belongs to whichever card was clicked — the footer's Skip OR
  // any row's 跳过 — so a multi-card task can skip a specific sub-action.
  const pendingSkip = App.skipFor ? c.actions.find((a) => a.id === App.skipFor) : null;

  return `
    <div class="w-full max-w-[800px]">
      <header class="mb-6">
        <div class="flex items-center gap-3 mb-3 flex-wrap">
          ${tierMeta ? `<span class="flex items-center gap-1.5 text-label-sm ${tierMeta.cls} px-2.5 py-1 rounded-full uppercase"><div class="w-1.5 h-1.5 rounded-full ${tierMeta.dot}"></div>${tierMeta.label}</span>` : ""}
          ${proj ? `<span class="text-[11px] font-mono text-on-surface-variant bg-surface-variant px-2.5 py-1 rounded">${escapeHtml(proj)}</span>` : ""}
          <span class="flex items-center gap-1 text-label-xs text-on-surface-variant ml-auto" title="AI last updated this card"><span class="material-symbols-outlined text-[14px]">update</span>Updated ${escapeHtml(timeAgo(clusterRecency(c)))}</span>
        </div>
        <h1 class="text-display text-on-surface mb-2 ${isChinese(title) ? "font-chinese" : ""}">${escapeHtml(title)}</h1>
        ${provenanceLine(primary)}
        ${plan?.why ? `<p class="text-body-lg font-medium ${plan.tier === "A" ? "text-red-600" : "text-on-surface-variant"} ${isChinese(plan.why) ? "font-chinese" : ""}">${escapeHtml(plan.why)}</p>` : ""}
      </header>

      ${primary.summary ? `
      <section class="bg-surface border border-outline rounded-xl p-5 mb-6">
        <h2 class="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2"><span class="material-symbols-outlined text-[16px]">info</span>Context</h2>
        <p class="text-body-base text-on-surface leading-relaxed ${isChinese(primary.summary) ? "font-chinese" : ""}">${escapeHtml(primary.summary)}</p>
        ${primary.context?.original_message ? `
        <details class="mt-3"><summary class="text-label-sm text-on-surface-variant cursor-pointer select-none">查看原始消息</summary>
          <p class="mt-2 text-body-medium text-on-surface-variant whitespace-pre-wrap border-l-2 border-outline pl-3 ${isChinese(primary.context.original_message) ? "font-chinese" : ""}">${escapeHtml(primary.context.original_message)}</p>
        </details>` : ""}
      </section>` : ""}

      <section class="mb-6">
        <h2 class="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2 px-1"><span class="material-symbols-outlined text-[16px]">task_alt</span>Resolution Plan</h2>
        <div class="flex flex-col gap-3">${c.actions.map(subActionRow).join("")}</div>
      </section>

      ${entities.length ? `
      <section class="mb-6">
        <h2 class="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2 px-1"><span class="material-symbols-outlined text-[16px]">category</span>Related Entities</h2>
        <div class="grid grid-cols-2 gap-3">${entities.map(entityCard).join("")}</div>
      </section>` : ""}

      ${pendingSkip ? skipReasonPanel(pendingSkip.id) : `
      <div class="flex items-center justify-between gap-md bg-surface border border-outline rounded-xl px-lg py-md">
        <div class="flex gap-md">
          ${readyCard ? `<button class="bg-primary text-white text-body-medium px-4 py-2 rounded hover:bg-blue-700 flex items-center gap-2" data-act="approve" data-id="${escapeHtml(readyCard.id)}"><span class="material-symbols-outlined text-[18px]">${execLabel(readyCard).icon}</span>${execLabel(readyCard).label}</button>${readyCard.draft != null ? `<button class="bg-surface text-on-surface text-body-medium px-4 py-2 rounded border border-outline hover:bg-slate-50" data-edit="${escapeHtml(readyCard.id)}">Edit</button>` : ""}` : `<span class="text-on-surface-variant text-body-base">Nothing ready to send — review the steps.</span>`}
        </div>
        ${skipTarget ? `<button class="text-on-surface-variant text-body-medium hover:text-on-surface" data-act="skip" data-id="${escapeHtml(skipTarget.id)}">Skip</button>` : ""}
      </div>`}
    </div>`;
}

// P0 typed skip. ONE click on a reason completes the skip — no confirm step,
// because the value of this instrumentation is entirely fill rate. The field
// checkboxes are optional and ORTHOGONAL: "the time was wrong" is a different
// fact from "this wasn't a real thing", and conflating them makes it impossible
// to tell a false positive from a good card with one bad field.
const SKIP_REASONS = [
  { key: "not_a_thing", label: "不是一件事", hint: "根本不该立项" },
  { key: "not_mine", label: "不该我做", hint: "是事,但不是指向我" },
  { key: "duplicate", label: "重复", hint: "已有同一条" },
  { key: "already_handled", label: "已处理过", hint: "早就解决了" },
  { key: "deferred", label: "现在不做", hint: "卡是对的,只是推迟" },
  { key: "other", label: "其他", hint: "" },
];
const SKIP_FIELDS = [
  { key: "time", label: "时间错" },
  { key: "person", label: "人错" },
  { key: "place", label: "地点错" },
];

function skipReasonPanel(id) {
  const esc = escapeHtml(id);
  return `
      <div class="bg-surface border border-outline rounded-xl px-lg py-md">
        <div class="flex items-center justify-between mb-3">
          <span class="text-label-sm text-on-surface-variant uppercase tracking-wider">为什么跳过?(点一下即完成)</span>
          <button class="text-label-sm text-on-surface-variant hover:text-on-surface" data-act="skip-cancel" data-id="${esc}">取消</button>
        </div>
        <div class="flex flex-wrap gap-2 mb-3">
          ${SKIP_REASONS.map((r) => `
          <button class="text-body-base px-3 py-1.5 rounded-lg border border-outline hover:bg-blue-50 hover:border-primary/40 text-on-surface ${isChinese(r.label) ? "font-chinese" : ""}"
                  data-act="skip-reason" data-id="${esc}" data-reason="${r.key}"
                  ${r.hint ? `title="${escapeHtml(r.hint)}"` : ""}>${escapeHtml(r.label)}</button>`).join("")}
        </div>
        <div class="flex items-center gap-3 text-label-sm text-on-surface-variant border-t border-outline pt-3">
          <span>顺手标字段错(可选):</span>
          ${SKIP_FIELDS.map((f) => `
          <label class="flex items-center gap-1 cursor-pointer hover:text-on-surface">
            <input type="checkbox" class="skip-field" value="${f.key}">
            <span class="${isChinese(f.label) ? "font-chinese" : ""}">${escapeHtml(f.label)}</span>
          </label>`).join("")}
        </div>
      </div>`;
}

// The message block: the LLM summary as the digest (sender named), with the
// raw original tucked behind a "Show original" expander. Legacy rows have no
// summary → show the original directly (the old behaviour).
function msgBlock(a, sender) {
  const orig = a.context?.original_message;
  const card = (inner) =>
    `<div class="bg-background rounded p-md border border-outline border-l-4 border-l-slate-300 mb-lg">
       <div class="text-label-sm font-bold text-on-surface mb-xs">${escapeHtml(sender)}</div>${inner}
     </div>`;
  if (a.summary) {
    const origDetails = orig
      ? `<details class="mt-sm"><summary class="text-label-sm text-on-surface-variant cursor-pointer select-none">Show original</summary>
           <p class="mt-xs text-body-medium text-on-surface-variant whitespace-pre-wrap ${isChinese(orig) ? "font-chinese" : ""}">${escapeHtml(orig)}</p></details>`
      : "";
    return card(
      `<p class="text-body-base text-on-surface whitespace-pre-wrap ${isChinese(a.summary) ? "font-chinese" : ""}">${escapeHtml(a.summary)}</p>${origDetails}`,
    );
  }
  if (orig) {
    return card(
      `<p class="text-body-base text-on-surface whitespace-pre-wrap ${isChinese(orig) ? "font-chinese" : ""}">${escapeHtml(orig)}</p>`,
    );
  }
  return "";
}

// Provenance line: "<platform> · <sender> · <MM-DD HH:mm>" — which channel,
// who, when. Time prefers context.sent_at (persisted at draft time); legacy
// cards predate that field, so fall back to the Slack ts embedded in
// source_message_id ("slack:<chan>:<ts.ts>"). Blank when neither exists —
// never guess.
function provenanceLine(a) {
  const platform = a.target?.platform || (a.source_message_id || "").split(":")[0] || "";
  const who = a.sender_name || a.context?.sender_handle || "";
  let d = null;
  const iso = a.context?.sent_at;
  if (iso) {
    const parsed = new Date(iso);
    if (!isNaN(parsed)) d = parsed;
  }
  if (!d && typeof a.source_message_id === "string") {
    const m = a.source_message_id.match(/^slack:[^:]+:(\d+(?:\.\d+)?)$/);
    if (m) d = new Date(parseFloat(m[1]) * 1000);
  }
  let when = "";
  if (d) {
    const p = (n) => String(n).padStart(2, "0");
    when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const parts = [platform, who, when].filter(Boolean);
  if (!parts.length) return "";
  return `<div class="text-label-sm text-on-surface-variant mb-md">${escapeHtml(parts.join(" · "))}</div>`;
}

// The project this card advances (set by the daemon: project_id + resolved
// project_name). A "MISC" / unset card shows a muted chip — it's not tied to a
// tracked project.
function projectBadge(a) {
  const pid = a.project_id;
  if (pid && pid !== "MISC") {
    const label = a.project_name || pid;
    return `<div class="mb-sm"><span class="inline-flex items-center gap-1 text-label-sm text-primary bg-primary/10 border border-primary/20 px-2.5 py-1 rounded-lg ${isChinese(label) ? "font-chinese" : ""}"><span class="material-symbols-outlined text-[15px]">folder</span>${escapeHtml(label)}</span></div>`;
  }
  return `<div class="mb-sm"><span class="inline-flex items-center gap-1 text-label-sm text-on-surface-variant bg-surface-variant px-2.5 py-1 rounded-lg"><span class="material-symbols-outlined text-[15px]">inbox</span>Misc</span></div>`;
}

function renderDetail(a) {
  const needsInfo = a.missing_info && a.missing_info.length > 0;
  const sender = a.sender_name || a.context?.sender_handle || "?";
  const recipient = a.recipient_name || a.target?.personaKey || a.target?.platform || "—";
  const isManual = a.status === "approved";

  const platIcon = { gmail: "mail", slack: "tag", wechat: "chat", calendar: "event" }[a.target?.platform] || "bolt";
  const title = a.headline || (a.params && a.params.title) || a.reason || a.action_type;

  const draftBlock = a.draft != null
    ? (App.editing
        ? `<textarea id="draft-edit" class="w-full min-h-[140px] bg-blue-50/50 rounded-lg p-md border border-blue-100 text-body-base text-on-surface ${isChinese(a.draft) ? "font-chinese" : ""}">${escapeHtml(a.draft)}</textarea>`
        : `<div class="relative bg-blue-50/50 rounded-lg p-md border border-blue-100">
             <div class="absolute top-2 right-2 bg-white border border-outline rounded-sm px-2 py-0.5 flex items-center gap-1 shadow-sm text-[10px]">
               <span class="font-bold text-primary">${isChinese(a.draft) ? "中文" : "EN"}</span>${a.params?._edited ? '<span class="text-on-surface-variant">· edited</span>' : ""}
             </div>
             <p class="text-body-base text-on-surface pr-16 whitespace-pre-wrap ${isChinese(a.draft) ? "font-chinese" : ""}">${escapeHtml(a.draft)}</p>
           </div>`)
    : "";

  const btn = (cls, act, label, dis) => `<button class="${cls}" data-act="${act}"${dis ? " disabled" : ""}>${label}</button>`;
  const primaryCls = "bg-primary text-white text-body-medium px-4 py-2 rounded hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed";
  const secondaryCls = "bg-surface text-on-surface text-body-medium px-4 py-2 rounded border border-outline hover:bg-slate-50 transition-colors";
  let actions;
  if (isManual) {
    const isGmail = a.target?.platform === "gmail";
    actions = `<div class="px-lg py-md bg-surface-variant border-y border-outline flex items-center gap-md">
      ${isGmail ? `<span class="text-body-medium text-on-surface-variant flex-1">Draft created — open Gmail to send.</span>` : btn(secondaryCls + " flex-1", "copy", "Copy")}
      ${btn(primaryCls, "mark-sent", '<span class="material-symbols-outlined text-[18px]">done</span> Mark sent')}
    </div>`;
  } else {
    const approveLabel = (a.action_type === "reply" || a.action_type === "relay" || a.action_type === "forward")
      ? '<span class="material-symbols-outlined text-[18px]">send</span> Approve &amp; Send' : "Approve";
    actions = `<div class="px-lg py-md bg-surface-variant border-y border-outline flex items-center justify-between">
      <div class="flex gap-md">
        ${btn(primaryCls, "approve", approveLabel, needsInfo)}
        ${App.editing ? btn(secondaryCls, "save-edit", "Save") : (a.draft != null ? btn(secondaryCls, "edit", "Edit") : "")}
      </div>
      ${btn("text-on-surface-variant text-body-medium hover:text-on-surface transition-colors", "skip", "Skip")}
    </div>`;
  }

  return `
    <div class="bg-surface border border-outline rounded w-full max-w-[800px] h-fit flex flex-col">
      <div class="p-lg">
        ${needsInfo ? `<div class="mb-md bg-amber-50 border border-amber-200 rounded p-md text-label-sm text-amber-700">Needs info: ${a.missing_info.map((m) => `<span class="bg-white border border-amber-200 rounded-sm px-2 py-0.5 mr-1">${escapeHtml(m)}</span>`).join(" ")}</div>` : ""}
        <div class="flex items-center gap-2 mb-md text-on-surface-variant">
          ${avatar(sender, sender)}
          <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
          <span class="material-symbols-outlined text-[16px]">${platIcon}</span>
          <span class="material-symbols-outlined text-[16px]">arrow_forward</span>
          ${avatar(String(recipient), String(recipient))}
          <span class="ml-auto text-label-xs uppercase tracking-wide text-on-surface-variant bg-surface-variant px-2 py-0.5 rounded-xl">${escapeHtml(a.action_type)}</span>
        </div>
        ${projectBadge(a)}
        <h2 class="text-display mb-md ${isChinese(title) ? "font-chinese" : ""}">${escapeHtml(title)}</h2>
        ${provenanceLine(a)}
        ${msgBlock(a, sender)}
        ${(a.next_actions && a.next_actions.length) ? `
          <div class="mb-lg bg-blue-50/40 border border-blue-100 rounded-lg p-md">
            <h3 class="text-label-sm text-primary font-bold uppercase tracking-wider mb-sm flex items-center gap-1.5"><span class="material-symbols-outlined text-[18px]">bolt</span> Action Items</h3>
            <ul class="flex flex-col gap-2">
              ${a.next_actions.map((t) => `<li class="flex items-start gap-2 text-body-base text-on-surface ${isChinese(t) ? "font-chinese" : ""}"><span class="material-symbols-outlined text-[18px] text-primary flex-shrink-0">arrow_right</span><span>${escapeHtml(t)}</span></li>`).join("")}
            </ul>
          </div>` : ""}
        ${draftBlock ? `<div><h3 class="text-label-sm text-on-surface-variant uppercase tracking-wider mb-sm">Draft</h3>${draftBlock}</div>` : ""}
      </div>
      ${actions}
    </div>`;
}

function renderDrawer() {
  const s = App.state;
  if (!s.done.length && !s.skipped.length) return "";
  const rowTitle = (a) => a.headline || (a.params && a.params.title) || a.summary || a.reason || a.action_type;
  const rows = s.skipped.map((a) => {
    const t = rowTitle(a);
    return `<div class="flex items-center gap-2 py-1.5 text-label-sm">
       <span class="text-on-surface-variant uppercase tracking-wide text-[10px] flex-shrink-0">${escapeHtml(a.action_type)}</span>
       <span class="text-on-surface-variant truncate flex-1 ${isChinese(t) ? "font-chinese" : ""}" title="${escapeHtml(t)}">${escapeHtml(t)}</span>
       <button class="text-primary hover:underline restore flex-shrink-0" data-restore="${escapeHtml(a.id)}">Restore</button>
     </div>`;
  }).join("");
  return `
    <details class="mt-lg border-t border-outline pt-sm">
      <summary class="text-label-sm text-on-surface-variant cursor-pointer select-none">Auto-handled (${s.done.length}) · Skipped (${s.skipped.length})</summary>
      <div class="mt-sm">${rows}</div>
    </details>`;
}

// ── queue interactions ────────────────────────────────────────────
// Click + keyboard both select at the TASK level: the detail pane follows
// App.selectedTaskId, so anything that acts on a card must go through the
// selected task's footer targets — never a selectedId left over from a card
// the user has since navigated away from (the old j/k set selectedId only,
// so `a` could approve a card the user wasn't looking at).

// The cluster the detail pane is actually showing (renderQueue's own
// fallback: the selected task, else the first live one).
function selectedCluster() {
  const clusters = liveClusters();
  return clusters.find((c) => taskKey(c) === App.selectedTaskId) || clusters[0] || null;
}

// Select a task (master-list click or j/k). selectedId is kept consistent
// with what the detail pane shows — the task's footer-target card — so any
// code path that still reads it acts on the visible task.
function selectTask(key) {
  App.selectedTaskId = key;
  App.editCardId = null;
  App.editing = false;
  const c = liveClusters().find((cl) => taskKey(cl) === key);
  App.selectedId = c ? (footerTargets(c).skipTarget?.id ?? c.actions[0]?.id ?? null) : null;
  render();
}

// j/k move across the visible .task-card elements — master-list DOM order is
// the single source of order, so navigation can never disagree with what's on
// screen. Selection happens at the task level; then the card scrolls into view.
export function moveSelection(delta) {
  const keys = [...document.querySelectorAll(".task-card")].map((el) => el.dataset.task);
  if (!keys.length) return;
  const idx = keys.indexOf(App.selectedTaskId);
  const next = idx < 0 ? 0 : Math.min(keys.length - 1, Math.max(0, idx + delta));
  selectTask(keys[next]);
  const el = document.querySelector(`.task-card[data-task="${CSS.escape(keys[next])}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

// a/e/s act on the SELECTED task — the same cards the detail footer's buttons
// target (approve/edit → readyCard, skip → skipTarget). Called from the
// keydown listener in main.js.
export function keyboardAction(act) {
  const c = selectedCluster();
  if (!c) return;
  const { readyCard, skipTarget } = footerTargets(c);
  if (act === "skip") {
    if (!skipTarget) return;
    App.selectedId = skipTarget.id;
    doAction("skip");
    return;
  }
  if (!readyCard) return;
  App.selectedId = readyCard.id;
  if (act === "edit") {
    // Mirror the [data-edit] click: drill into the single-card editor.
    if (readyCard.draft == null) return;
    App.editCardId = readyCard.id;
    App.editing = true;
    render();
    const ta = document.getElementById("draft-edit");
    if (ta) ta.focus();
  } else {
    doAction("approve");
  }
}

export function wireQueue() {
  document.querySelectorAll(".task-card").forEach((r) => {
    r.onclick = () => selectTask(r.dataset.task);
    // Drag a card to another tier section to re-prioritize it manually.
    r.ondragstart = (e) => { e.dataTransfer.setData("text/plain", r.dataset.task); e.dataTransfer.effectAllowed = "move"; r.classList.add("opacity-40"); };
    r.ondragend = () => r.classList.remove("opacity-40");
  });
  document.querySelectorAll(".drop-tier").forEach((z) => {
    z.ondragover = (e) => { e.preventDefault(); z.classList.add("bg-blue-50", "ring-1", "ring-primary/40"); };
    z.ondragleave = () => z.classList.remove("bg-blue-50", "ring-1", "ring-primary/40");
    z.ondrop = (e) => {
      e.preventDefault();
      z.classList.remove("bg-blue-50", "ring-1", "ring-primary/40");
      const key = e.dataTransfer.getData("text/plain");
      if (key && z.dataset.dropTier) setTaskTier(key, z.dataset.dropTier);
    };
  });
  document.querySelectorAll("[data-act]").forEach((b) =>
    b.onclick = (e) => { e.stopPropagation(); if (b.dataset.id) App.selectedId = b.dataset.id; doAction(b.dataset.act, b.dataset.reason); },
  );
  document.querySelectorAll("[data-edit]").forEach((b) =>
    b.onclick = (e) => {
      e.stopPropagation();
      App.editCardId = b.dataset.edit; App.selectedId = b.dataset.edit; App.editing = true;
      render();
      const ta = document.getElementById("draft-edit"); if (ta) ta.focus();
    },
  );
  document.querySelectorAll(".back-task").forEach((b) =>
    b.onclick = () => { App.editCardId = null; App.editing = false; render(); },
  );
  document.querySelectorAll("[data-restore]").forEach((b) =>
    b.onclick = () => restore(b.dataset.restore),
  );
}

async function doAction(act, arg) {
  const id = App.selectedId;
  if (!id) return;
  try {
    if (act === "approve") {
      // If the draft was edited but not yet Saved, persist the textarea first
      // so we send the EDITED text — not the stale server-side draft.
      if (App.editing) {
        const ta = document.getElementById("draft-edit");
        if (ta) {
          await apiPost(`/api/actions/${encodeURIComponent(id)}/edit`, { draft: ta.value });
          App.editing = false;
        }
      }
      const res = await apiPost(`/api/actions/${encodeURIComponent(id)}/approve`, {});
      if (!res.ok && res.conflicts) {
        toast(`Conflict with ${res.conflicts.length} event(s) — pick another time`, true);
      } else if (res.awaitingManual) {
        toast("Draft created — awaiting your send");
      } else {
        animateApprove(id);
        toast("Sent");
      }
      App.selectedId = null;
      App.editCardId = null; // return to the task view
      await refresh();
    } else if (act === "edit") {
      App.editing = true;
      render();
      const ta = document.getElementById("draft-edit");
      if (ta) ta.focus();
    } else if (act === "save-edit") {
      const ta = document.getElementById("draft-edit");
      await apiPost(`/api/actions/${encodeURIComponent(id)}/edit`, { draft: ta.value });
      App.editing = false;
      await refresh();
      App.selectedId = id;
      render();
    } else if (act === "skip") {
      // P0: skipping now asks WHY, because 168 historical rejections carried
      // exactly 1 reason between them — the largest information loss in the
      // system. One click on a reason completes the skip (no confirm step): the
      // value of this instrumentation is entirely determined by fill rate.
      App.skipFor = id;
      render();
    } else if (act === "skip-reason") {
      const existence = arg;
      const idx = selectableIds().indexOf(id);
      const fieldErrors = [...document.querySelectorAll(".skip-field:checked")].map((c) => c.value);
      await apiPost(`/api/actions/${encodeURIComponent(id)}/skip`, {
        existence,
        field_errors: fieldErrors,
      });
      App.skipFor = null;
      await refresh();
      const next = selectableIds();
      App.selectedId = next.length ? next[Math.min(idx, next.length - 1)] : null;
      App.editCardId = null; // return to the task view
      render();
    } else if (act === "skip-cancel") {
      App.skipFor = null;
      render();
    } else if (act === "mark-sent") {
      await apiPost(`/api/actions/${encodeURIComponent(id)}/mark-sent`, {});
      App.selectedId = null;
      await refresh();
      toast("Marked sent");
    } else if (act === "done") {
      // A Me · reminder sub-action (task/ignore): mark done — executed with a
      // local receipt, no send, no missing-info gate.
      await apiPost(`/api/actions/${encodeURIComponent(id)}/done`, {});
      App.selectedId = null;
      App.editCardId = null;
      await refresh();
      toast("Marked done");
    } else if (act === "copy") {
      const a = allLiveActions().find(({ action }) => action.id === id)?.action;
      if (a && a.draft) {
        await navigator.clipboard.writeText(a.draft);
        toast("Copied — paste into WeChat");
      }
    }
  } catch (e) {
    toast(e.message, true);
  }
}

async function setTaskTier(key, tier) {
  try {
    await apiPost(`/api/tasks/${encodeURIComponent(key)}/tier`, { tier });
    App.selectedTaskId = key; // keep it selected after it moves
    await refresh();
    toast(`Moved to ${tier}`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function restore(id) {
  try {
    await apiPost(`/api/actions/${encodeURIComponent(id)}/restore`, {});
    await refresh();
    toast("Restored to queue");
  } catch (e) {
    toast(e.message, true);
  }
}

// Approve slide-out — one of the two allowed motions. Targets the acted
// card's .task-card (the old .row element no longer exists).
function animateApprove(id) {
  const c = liveClusters().find((cl) => cl.actions.some((a) => a.id === id));
  if (!c) return;
  const el = document.querySelector(`.task-card[data-task="${CSS.escape(taskKey(c))}"]`);
  if (el) el.classList.add("removing");
}
