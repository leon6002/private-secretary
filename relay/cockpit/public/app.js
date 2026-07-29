// secretary cockpit — vanilla SPA. Reads /api/state + /api/personas,
// renders Queue / People / Connections, drives triage through the API.
// Two motions only (approve slide-out, badge tick); everything else is
// instantaneous. Keyboard-first.

const CSRF = document.querySelector('meta[name="csrf-token"]').content;

// ── api ───────────────────────────────────────────────────────────
async function apiGet(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": CSRF },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ── app state ─────────────────────────────────────────────────────
const App = {
  screen: "queue",
  state: null, // /api/state payload
  personas: null, // persona[]
  selectedId: null, // card being acted on (per-row / footer / edit)
  selectedTaskId: null, // selected task in Today
  editCardId: null, // when set, Today detail drills into this card's editor
  skipFor: null, // when set, that card's footer shows the typed-skip reason picker
  selectedPerson: null, // selected persona key in People
  projects: null, // /api/projects payload {projects, misc}
  selectedProject: null, // selected project id in Projects (or "__misc")
  editing: false, // draft edit mode in detail pane
  gPrefix: false, // "g" chord pending
};

// ── util ──────────────────────────────────────────────────────────
function hueFromKey(key) {
  let h = 0;
  for (const ch of key || "?") h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatar(label, key, size = 24, photo) {
  const initials = (label || "?").trim().slice(0, 2).toUpperCase();
  const hue = hueFromKey(key || label);
  // Two-layer: initials chip is always the base; a real head photo (Slack/WeChat)
  // overlays it and fills the circle. If the photo URL fails, the <img> removes
  // itself (onerror) and the initials show through — no broken image, no markup
  // escaping games.
  const img = photo
    ? `<img src="${escapeHtml(photo)}" alt="" class="absolute inset-0 w-full h-full object-cover rounded-full" onerror="this.remove()">`
    : "";
  return `<span class="avatar relative overflow-hidden" style="width:${size}px;height:${size}px;background:hsl(${hue} 45% 45%)">${escapeHtml(initials)}${img}</span>`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function isChinese(s) {
  return /[一-鿿]/.test(s || "");
}
function langBadge(text) {
  return `<span class="lang-badge">${isChinese(text) ? "中文" : "EN"}</span>`;
}
function toast(msg, isErr) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ── data load ─────────────────────────────────────────────────────
async function refresh() {
  App.state = await apiGet("/api/state");
  updateBadge();
  render();
}

// Signature of the parts that affect the rendered UI — used to skip needless
// re-renders on the poll (so the page doesn't churn every 15s).
function stateSig(s) {
  if (!s) return "";
  const parts = [JSON.stringify(s.counts)];
  for (const c of s.clusters || []) for (const a of c.actions || []) parts.push(a.id + ":" + a.status);
  for (const a of s.awaitingManual || []) parts.push("am:" + a.id);
  for (const a of s.done || []) parts.push("d:" + a.id);
  for (const a of s.skipped || []) parts.push("k:" + a.id);
  return parts.join("|");
}

// The 15s background poll. NEVER clobber an in-progress edit or a focused
// input (that wiped what you were typing), and skip the re-render entirely
// when nothing changed (so the page doesn't jump while you read/scroll).
async function pollRefresh() {
  if (App.editing) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) return;
  const next = await apiGet("/api/state");
  const changed = stateSig(next) !== stateSig(App.state);
  App.state = next;
  updateBadge();
  if (changed) render();
}
function updateBadge() {
  const badge = document.getElementById("pending-badge");
  const n = App.state?.counts?.pending ?? 0;
  if (n > 0) {
    if (badge.textContent !== String(n)) {
      badge.classList.add("ticking");
      setTimeout(() => badge.classList.remove("ticking"), 220);
    }
    badge.textContent = String(n);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ── render dispatch ───────────────────────────────────────────────
let _lastScreen = null;
let _lastPerson = null;
// Remembered scrollTop of every [data-scroll] pane, keyed by its data-scroll name.
// Needed because render() replaces the whole screen's innerHTML: without this the
// People contact rail jumped back to the top every time you clicked a contact.
const _scrollMem = {};
function render() {
  document.querySelectorAll(".rail-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.screen === App.screen),
  );
  const host = document.getElementById("screen");
  // Preserve scroll across a same-screen re-render (the 15s poll re-renders the
  // whole screen; without this it snaps back to the top while you're reading).
  const sameScreen = _lastScreen === App.screen;
  const prevMaster = sameScreen ? host.querySelector(".master")?.scrollTop ?? null : null;
  const prevWinY = sameScreen ? window.scrollY : 0;
  if (sameScreen) {
    host.querySelectorAll("[data-scroll]").forEach((el) => {
      _scrollMem[el.dataset.scroll] = el.scrollTop;
    });
  }
  // Selecting a DIFFERENT person should start their profile at the top; the rail
  // itself always keeps its place.
  if (App.selectedPerson !== _lastPerson) _scrollMem["people-main"] = 0;
  if (App.screen === "queue") host.innerHTML = renderQueue();
  else if (App.screen === "projects") host.innerHTML = renderProjects();
  else if (App.screen === "people") host.innerHTML = renderPeople();
  else host.innerHTML = renderConnections();
  wireScreen();
  // Restore the remembered pane scrolls (rail keeps its place across clicks/polls).
  host.querySelectorAll("[data-scroll]").forEach((el) => {
    const v = _scrollMem[el.dataset.scroll];
    if (typeof v === "number") el.scrollTop = v;
  });
  if (sameScreen) {
    const m = host.querySelector(".master");
    if (m && prevMaster != null) m.scrollTop = prevMaster;
    window.scrollTo(0, prevWinY);
  }
  _lastScreen = App.screen;
  _lastPerson = App.selectedPerson;
}

// ── QUEUE ─────────────────────────────────────────────────────────
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

// A task cluster's unit key — must match the backend (plan.ts unitKey / api).
function taskKey(c) {
  return c.task_id || (c.actions[0] ? `__ungrouped_${c.actions[0].id}` : "");
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
function renderQueue() {
  const s = App.state;
  // MUTED (per user): the sourceErrors notices — a source that couldn't be reached
  // (cursor frozen) or an LLM step that timed out (self-retries) — are all non-fatal
  // and self-healing ("nothing lost"), so they no longer render as queue banners.
  // A genuine outage still surfaces in the People screen's connection status.
  const banners = "";
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
    </header>${banners}`;

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

function renderTaskDetail(c) {
  const title = c.title || (c.actions[0] && (c.actions[0].headline || c.actions[0].reason)) || "Task";
  const plan = c.plan;
  const tierMeta = plan ? { A: { cls: "text-red-600 bg-red-50", dot: "bg-red-500", label: "A · Do first" }, B: { cls: "text-amber-600 bg-amber-50", dot: "bg-amber-500", label: "B · Today" }, C: { cls: "text-primary bg-primary/10", dot: "bg-primary", label: "C · This week" }, D: { cls: "text-on-surface-variant bg-surface-variant", dot: "bg-slate-400", label: "D · Later" } }[plan.tier] : null;
  const proj = c.actions.find((a) => a.project_id && a.project_id !== "MISC")?.project_id;
  // Context = the digest only (the raw thread quote is noise — see feedback).
  const primary = c.actions.find((a) => a.summary) || c.actions[0] || {};
  const entities = plan?.entities || [];
  // Footer primary = first ready AI-executable suggested card.
  const readyCard = c.actions.find((a) => a.status === "suggested" && !(a.missing_info && a.missing_info.length) && execLabel(a).assignee === "ai");
  // Skip must work on ANY still-suggested card, not only AI-sendable ones. Gating
  // it on readyCard left `Me · reminder` (task) and `Needs info` cards with no way
  // to skip at all — and `task` is the highest-volume, lowest-precision type
  // (126 decided, 0.444), i.e. exactly where the reason signal matters most.
  const skipTarget = readyCard || c.actions.find((a) => a.status === "suggested");
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
        ${plan?.why ? `<p class="text-body-lg font-medium ${plan.tier === "A" ? "text-red-600" : "text-on-surface-variant"} ${isChinese(plan.why) ? "font-chinese" : ""}">${escapeHtml(plan.why)}</p>` : ""}
      </header>

      ${primary.summary ? `
      <section class="bg-surface border border-outline rounded-xl p-5 mb-6">
        <h2 class="text-label-sm text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-2"><span class="material-symbols-outlined text-[16px]">info</span>Context</h2>
        <p class="text-body-base text-on-surface leading-relaxed ${isChinese(primary.summary) ? "font-chinese" : ""}">${escapeHtml(primary.summary)}</p>
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

function renderRow(a) {
  const needsInfo = a.missing_info && a.missing_info.length > 0;
  const selected = a.id === App.selectedId;
  const manual = a.status === "approved";
  const icons = { reply: "send", relay: "forward_to_inbox", forward: "forward", calendar: "event", task: "check_circle", ignore: "archive" };
  let st;
  if (manual) st = { pill: "Awaiting", txt: "text-emerald-600", bg: "bg-emerald-50", icon: "drafts", border: "border-l-emerald-500" };
  else if (needsInfo) st = { pill: "Needs info", txt: "text-amber-600", bg: "bg-amber-50", icon: "help", border: "border-l-amber-500" };
  else if (a.action_type === "task" || a.action_type === "ignore") st = { pill: a.action_type, txt: "text-slate-600", bg: "bg-slate-100", icon: icons[a.action_type], border: "border-l-slate-400" };
  else st = { pill: "Ready", txt: "text-primary", bg: "bg-white", icon: icons[a.action_type] || "send", border: "border-l-primary" };
  const base = selected
    ? "bg-blue-50 border border-primary shadow-[inset_3px_0_0_0_#2563EB]"
    : `bg-surface border border-outline border-l-[3px] ${st.border} hover:bg-slate-50`;
  const body = a.draft || a.headline || (a.params && a.params.title) || a.reason || "";
  return `
    <div class="row rounded p-md cursor-pointer transition-colors ${base}" data-id="${escapeHtml(a.id)}">
      <div class="flex justify-between items-start mb-sm">
        <div class="flex items-center gap-xs">
          <span class="material-symbols-outlined text-[16px] ${st.txt}">${st.icon}</span>
          <span class="text-label-xs ${st.txt} ${st.bg} px-2 py-0.5 rounded-xl uppercase tracking-wide">${escapeHtml(st.pill)}</span>
        </div>
        <span class="text-label-sm text-on-surface-variant flex-shrink-0">${escapeHtml(timeAgo(a.created_at))}</span>
      </div>
      <div class="text-label-sm text-on-surface-variant mb-1 truncate">${escapeHtml(routingText(a))}</div>
      <p class="text-body-medium text-on-surface line-clamp-2 ${isChinese(body) ? "font-chinese" : ""}">${escapeHtml(body)}</p>
    </div>`;
}

function routingText(a) {
  const sender = a.sender_name || a.context?.sender_handle || "?";
  const recipient = a.recipient_name || a.target?.personaKey || a.target?.platform || "—";
  return `${sender} → ${recipient}`;
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

// ── PEOPLE ────────────────────────────────────────────────────────
function renderPeople() {
  const personas = App.personas || [];
  const sel = App.selectedPerson || (personas[0] && personas[0].key);
  // Show only the first 5, then a "+N" chip (click → show all). Keeps the rail
  // tidy instead of a long scroll of everyone.
  const CAP = 5;
  const shown = App.showAllPeople ? personas : personas.slice(0, CAP);
  const rest = personas.length - shown.length;
  const avatars = shown.map((p) => {
    const active = p.key === sel;
    const name = p.display_name || p.key;
    return `<div class="contact-item cursor-pointer ${active ? "" : "opacity-60 hover:opacity-100"} transition-opacity" data-person="${escapeHtml(p.key)}" title="${escapeHtml(name)}">
      <div class="${active ? "ring-2 ring-primary p-[2px] rounded-full" : ""}">${avatar(name, p.key, 40, p.avatar)}</div>
    </div>`;
  }).join("");
  const overflow = (!App.showAllPeople && rest > 0)
    ? `<div class="contact-more w-10 h-10 rounded-full bg-surface-variant text-on-surface-variant flex items-center justify-center text-label-sm font-semibold cursor-pointer hover:bg-outline/20 transition-colors" title="Show all ${personas.length}">+${rest}</div>`
    : "";
  const person = personas.find((p) => p.key === sel);
  return `
    <div class="flex-1 flex overflow-hidden">
      <aside data-scroll="people-rail" class="w-[72px] flex-shrink-0 bg-surface border-r border-outline flex flex-col items-center py-sm gap-sm overflow-y-auto hide-scrollbar">${avatars}${overflow}</aside>
      <main data-scroll="people-main" class="flex-1 overflow-y-auto bg-background">${person ? renderProfile(person) : '<div class="p-lg text-on-surface-variant text-body-base">No personas yet.</div>'}</main>
    </div>`;
}

function renderProfile(p) {
  const name = p.display_name || p.key;
  const rm = p.relationship_meta || {};
  const id = p.identity || {};
  const comm = p.communication || {};
  const h = p.handles || {};
  const ch = (s) => isChinese(s || "") ? "font-chinese" : "";

  const powerLabel = { "leads-them": "Leads-them", peer: "Peer", "serves-them": "Serves-them" }[rm.power];
  const powerIcon = { "leads-them": "arrow_upward", peer: "drag_handle", "serves-them": "arrow_downward" }[rm.power] || "person";

  const pill = (on, label, icon, cls) =>
    `<div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ${on ? cls : "bg-surface-variant text-on-surface-variant border border-dashed border-outline opacity-50"}"><span class="material-symbols-outlined text-[16px]">${icon}</span><span class="text-label-sm">${label}</span></div>`;
  const handlePills =
    pill(h.slack, "Slack", "chat", "bg-[#EAE5EB] text-[#4A154B]") +
    pill(h.gmail, "Gmail", "mail", "bg-[#FCECEB] text-[#EA4335]") +
    pill(h.wechat, "WeChat", "forum", "bg-emerald-50 text-emerald-700");

  const chip = (v) => v ? `<span class="px-2.5 py-1 rounded-full bg-surface-variant text-on-surface text-label-sm border border-outline ${ch(v)}">${escapeHtml(v)}</span>` : "";
  const lang = comm.language === "zh" ? "中文" : comm.language === "en" ? "English" : (comm.language || null);
  // Live local time in the contact's timezone (recomputed each render/poll).
  let timeChip = "";
  if (comm.timezone) {
    let t = "";
    try { t = new Intl.DateTimeFormat("en-GB", { timeZone: comm.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date()); } catch (e) { /* bad tz */ }
    timeChip = `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-variant text-on-surface text-label-sm border border-outline"><span class="material-symbols-outlined text-[14px]">schedule</span>${escapeHtml(comm.timezone)}${t ? " · " + t : ""}</span>`;
  }
  // Short role/relationship teasers as chips (the full text lives in Core Knowledge).
  const roleShort = id.role ? clip(id.role.split(/[—.]/)[0], 40) : (id.org || "");
  const relShort = id.relationship ? clip(id.relationship.split(/[—.]/)[0], 40) : "";
  const metaChips = [chip(roleShort), chip(relShort), chip(lang), chip(comm.register), timeChip].filter(Boolean).join("");

  // Core Knowledge field: the VALUE is always shown; the evidence lives in a
  // SOURCE EVIDENCE popover revealed ON HOVER, so the card stays concise. Role/Org
  // are already in the header chips, so they're dropped here.
  const fieldCard = (f) => {
    const badge = f.provenance === "manual"
      ? `<div class="flex items-center justify-center w-5 h-5 rounded bg-surface-variant text-on-surface-variant flex-shrink-0" title="Manual"><span class="material-symbols-outlined text-[12px]" style="font-variation-settings:'FILL' 1">lock</span></div>`
      : `<div class="flex items-center justify-center w-5 h-5 rounded border border-dashed border-primary text-primary bg-primary/5 flex-shrink-0" title="Inferred"><span class="text-[10px] font-bold">I</span></div>`;
    const pop = f.evidence ? `
      <div class="absolute z-30 left-2 right-2 top-full bg-surface border border-outline rounded-lg shadow-lg p-3 hidden group-hover:block">
        <div class="text-label-xs uppercase tracking-wider text-on-surface-variant mb-1">Source evidence</div>
        <p class="text-body-medium text-on-surface italic border-l-2 border-primary/40 pl-2 ${ch(f.evidence)}">${escapeHtml(clip(f.evidence, 220))}</p>
      </div>` : "";
    return `<div class="group relative flex flex-col gap-1 p-3 rounded-lg bg-background border border-transparent hover:border-outline hover:shadow-sm transition ${f.evidence ? "cursor-help" : ""}">
      <div class="flex items-center justify-between gap-2"><span class="text-label-sm text-on-surface-variant">${escapeHtml(f.label)}</span>${badge}</div>
      <span class="text-body-base text-on-surface font-medium ${ch(f.value)}">${escapeHtml(f.value)}</span>
      ${pop}
    </div>`;
  };
  const coreFields = (p.fields || [])
    .filter((f) => f.label !== "Role" && f.label !== "Org")
    .map(fieldCard).join("") || '<div class="text-on-surface-variant text-body-base sm:col-span-2">— nothing observed yet</div>';

  const taskIcon = { reply: "send", task: "check_circle", calendar: "event", ignore: "archive" };
  const taskRows = (p.tasks || []).map((t) => {
    const badge = t.status === "approved"
      ? '<span class="px-2 py-0.5 rounded-full bg-surface-variant text-on-surface-variant text-[10px] uppercase tracking-wider font-bold flex-shrink-0">Waiting</span>'
      : '<span class="px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 text-[10px] uppercase tracking-wider font-bold flex-shrink-0">Action needed</span>';
    return `<div class="px-5 py-3.5 border-b border-outline last:border-0 hover:bg-surface-variant">
      <div class="flex items-center justify-between gap-4"><span class="text-body-medium truncate ${ch(t.title)}">${escapeHtml(t.title)}</span>${badge}</div>
      <div class="flex items-center gap-1.5 mt-1 text-on-surface-variant"><span class="material-symbols-outlined text-[15px]">${taskIcon[t.action_type] || "bolt"}</span><span class="text-label-sm">${escapeHtml(t.action_type)}</span></div>
    </div>`;
  }).join("") || '<div class="px-5 py-4 text-on-surface-variant text-body-base">No active items.</div>';

  const commits = p.commitments || [];
  const commitRow = (c) => `<div class="flex items-start justify-between gap-2 p-3"><span class="text-body-base min-w-0 ${ch(c.what)}">${escapeHtml(c.what)}${c.due ? `<span class="block text-label-sm text-on-surface-variant">${escapeHtml(c.due)}</span>` : ""}</span>${c.status === "overdue" ? '<span class="text-label-xs text-error font-semibold flex-shrink-0">Overdue</span>' : ""}</div>`;
  const them = commits.filter((c) => c.who === "them").map(commitRow).join("") || '<div class="p-3 text-on-surface-variant text-label-sm">—</div>';
  const me = commits.filter((c) => c.who === "me").map(commitRow).join("") || '<div class="p-3 text-on-surface-variant text-label-sm">—</div>';

  const otRaw = p.open_threads;
  const otList = Array.isArray(otRaw) ? otRaw : (otRaw ? [otRaw] : []);
  const otBlock = otList.length
    ? otList.map((t) => `<div class="flex items-start gap-3 py-1"><div class="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0"></div><span class="text-body-base ${ch(t)}">${escapeHtml(t)}</span></div>`).join("")
    : '<span class="text-on-surface-variant italic text-body-base">— none open</span>';
  const cardHover = "transition hover:shadow-md";

  return `
    <div class="p-lg xl:px-16 pb-24">
      <div class="max-w-5xl mx-auto flex flex-col gap-lg">
        <header class="flex flex-col gap-3">
          <div class="flex items-end justify-between flex-wrap gap-3">
            <div class="flex items-center gap-3">
              <h1 class="text-[32px] leading-[40px] font-bold tracking-[-0.02em] ${ch(name)}">${escapeHtml(name)}</h1>
              ${powerLabel ? `<div class="flex items-center gap-1 text-primary bg-primary/10 px-2 py-1 rounded-lg border border-primary/20"><span class="material-symbols-outlined text-[16px]">${powerIcon}</span><span class="text-label-sm font-semibold">${powerLabel}</span></div>` : ""}
            </div>
            <div class="flex items-center gap-2 flex-wrap">${handlePills}</div>
          </div>
          <div class="flex flex-wrap items-center gap-2">${metaChips}</div>
        </header>

        <section class="grid grid-cols-1 lg:grid-cols-3 gap-lg">
          <div class="lg:col-span-2 bg-surface rounded-xl border border-outline p-5 ${cardHover}">
            <h2 class="text-headline mb-4">Core Knowledge</h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${coreFields}</div>
          </div>
          <div class="bg-surface rounded-xl border border-outline p-5 ${cardHover}">
            <h2 class="text-headline mb-4 flex items-center gap-2"><span class="material-symbols-outlined text-[20px] text-primary">record_voice_over</span> Voice &amp; Style</h2>
            <div class="flex flex-col gap-4">
              <div><span class="block text-label-sm text-on-surface-variant mb-1">Tone</span><span class="text-body-base ${ch(comm.tone_notes)}">${comm.tone_notes ? escapeHtml(clip(comm.tone_notes, 160)) : '<span class="text-on-surface-variant italic">— not observed</span>'}</span></div>
              <div><span class="block text-label-sm text-on-surface-variant mb-1">Register</span><span class="text-body-base">${comm.register ? escapeHtml(comm.register) : '<span class="text-on-surface-variant italic">—</span>'}</span></div>
            </div>
          </div>
        </section>

        <section class="bg-surface rounded-xl border border-outline overflow-hidden ${cardHover}">
          <div class="p-5 border-b border-outline"><h2 class="text-headline">Active Tasks</h2></div>
          <div class="flex flex-col">${taskRows}</div>
        </section>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-lg">
          <section class="bg-surface rounded-xl border border-outline overflow-hidden flex flex-col ${cardHover}">
            <div class="p-4 border-b border-outline"><h2 class="text-headline">Commitments Ledger</h2></div>
            <div class="grid grid-cols-2 border-b border-outline bg-surface-variant">
              <div class="p-3 text-label-sm text-on-surface-variant uppercase tracking-wider border-r border-outline">They owe</div>
              <div class="p-3 text-label-sm text-on-surface-variant uppercase tracking-wider">I owe</div>
            </div>
            <div class="grid grid-cols-2">
              <div class="border-r border-outline divide-y divide-outline">${them}</div>
              <div class="divide-y divide-outline">${me}</div>
            </div>
          </section>
          <section class="bg-surface rounded-xl border border-outline overflow-hidden ${cardHover}">
            <div class="p-4 border-b border-outline"><h2 class="text-headline">Open Threads</h2></div>
            <div class="p-4 flex flex-col gap-1">${otBlock}</div>
          </section>
        </div>
      </div>
    </div>`;
}

// ── PROJECTS (Microsoft To-Do style) ──────────────────────────────
function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const COMPANY_LABEL = {
  oushikesi: "欧思克斯 · OUS",
  osyx: "OSYX",
  taiv: "Taiv",
  tool: "Tools",
  tools: "Tools",
};

function renderProjects() {
  const data = App.projects;
  if (!data) {
    return `<div class="flex-1 flex items-center justify-center text-on-surface-variant text-body-base">Loading projects…</div>`;
  }
  const projects = data.projects || [];
  const misc = data.misc || [];
  const sel = App.selectedProject || (projects[0] && projects[0].id) || "__misc";

  const listRow = (id, icon, label, n, active) => `
    <div data-project="${escapeHtml(id)}" class="flex items-center gap-2.5 px-3 py-2 rounded-md cursor-pointer ${active ? "bg-primary/10" : "hover:bg-surface-variant"}">
      <span class="material-symbols-outlined text-[18px] ${active ? "text-primary" : "text-on-surface-variant"}">${icon}</span>
      <span class="text-body-medium truncate ${active ? "text-primary font-semibold" : "text-on-surface"} ${isChinese(label) ? "font-chinese" : ""}">${escapeHtml(label)}</span>
      ${n > 0 ? `<span class="ml-auto text-label-xs ${active ? "text-primary bg-surface" : "text-on-surface-variant bg-surface-variant"} px-1.5 rounded-full">${n}</span>` : ""}
    </div>`;

  // group projects by company
  const groups = new Map();
  for (const p of projects) {
    const key = p.company || "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  let sidebar = listRow("__misc", "inbox", "Misc", misc.length, sel === "__misc");
  for (const [company, ps] of groups) {
    sidebar += `<div class="px-3 pt-4 pb-1 text-label-xs uppercase tracking-wider text-on-surface-variant">${escapeHtml(COMPANY_LABEL[company] || company)}</div>`;
    for (const p of ps) sidebar += listRow(p.id, "check_circle", p.name, (p.cards || []).length, sel === p.id);
  }

  let main;
  if (sel === "__misc") {
    main = projectMain({ name: "Misc", company: "", goal: "Cards not tied to a tracked project.", status: "", current_state: "", needs: [], blockers: [], cards: misc });
  } else {
    const p = projects.find((x) => x.id === sel) || projects[0];
    main = p ? projectMain(p) : `<div class="p-lg text-on-surface-variant">No projects yet.</div>`;
  }

  return `
    <div class="flex-1 flex overflow-hidden">
      <aside class="w-[280px] flex-shrink-0 border-r border-outline bg-surface overflow-y-auto hide-scrollbar p-2 flex flex-col gap-0.5">
        <div class="px-3 py-3 text-headline">Projects</div>
        ${sidebar}
      </aside>
      <main class="flex-1 overflow-y-auto bg-background">${main}</main>
    </div>`;
}

function projectMain(p) {
  const cards = p.cards || [];
  const taskRow = (c) => {
    const naCount = (c.next_actions || []).length;
    const needs = c.missing_info && c.missing_info.length;
    return `
      <div data-card="${escapeHtml(c.id)}" class="group flex items-start gap-3 bg-surface border border-outline rounded-lg px-4 py-3 cursor-pointer hover:border-primary/50 transition-colors">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant group-hover:text-primary mt-0.5">radio_button_unchecked</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-body-medium text-on-surface truncate ${isChinese(c.headline) ? "font-chinese" : ""}">${escapeHtml(c.headline || "(untitled)")}</span>
            <span class="text-label-xs uppercase tracking-wide text-on-surface-variant bg-surface-variant px-1.5 py-0.5 rounded flex-shrink-0">${escapeHtml(c.action_type)}</span>
            ${needs ? `<span class="text-label-xs text-amber-600 flex-shrink-0">needs info</span>` : ""}
          </div>
          ${c.summary ? `<div class="text-label-sm text-on-surface-variant truncate ${isChinese(c.summary) ? "font-chinese" : ""}">${escapeHtml(c.summary)}</div>` : ""}
          <div class="text-label-xs text-on-surface-variant mt-0.5 ${isChinese(c.sender_name) ? "font-chinese" : ""}">${escapeHtml(c.sender_name || "")}${naCount ? ` · ${naCount} action${naCount > 1 ? "s" : ""}` : ""}</div>
        </div>
      </div>`;
  };
  const tasksBlock = cards.length
    ? cards.map(taskRow).join("")
    : `<div class="text-on-surface-variant text-body-base py-10 text-center">No open cards for this project.</div>`;

  const needs = p.needs || [];
  const needsBlock = needs.length
    ? `<div class="mt-8">
         <h3 class="text-label-sm uppercase tracking-wider text-on-surface-variant mb-2">Open needs / gaps</h3>
         <div class="flex flex-col gap-1.5">
           ${needs.map((n) => `<div class="flex items-start gap-2 text-body-base text-on-surface ${isChinese(n.need) ? "font-chinese" : ""}"><span class="text-label-xs uppercase ${n.status === "gap" ? "text-error" : "text-amber-600"} mt-1 flex-shrink-0">${escapeHtml(n.status || "")}</span><span>${escapeHtml(n.need)}</span></div>`).join("")}
         </div>
       </div>`
    : "";

  return `
    <div class="bg-gradient-to-b from-blue-50 to-transparent px-lg pt-lg pb-md border-b border-outline">
      <div class="flex items-center gap-2 mb-1">
        ${p.company ? `<span class="text-label-xs uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded">${escapeHtml(COMPANY_LABEL[p.company] || p.company)}</span>` : ""}
        ${p.status ? `<span class="text-label-xs text-on-surface-variant">${escapeHtml(p.status)}</span>` : ""}
        <span class="ml-auto text-label-sm text-on-surface-variant">${cards.length} open</span>
      </div>
      <h1 class="text-display ${isChinese(p.name) ? "font-chinese" : ""}">${escapeHtml(p.name)}</h1>
      ${p.goal ? `<p class="text-body-medium text-on-surface-variant mt-2 max-w-3xl ${isChinese(p.goal) ? "font-chinese" : ""}">${escapeHtml(clip(p.goal, 320))}</p>` : ""}
    </div>
    <div class="px-lg pt-md pb-24 max-w-3xl">
      <div class="flex flex-col gap-2">${tasksBlock}</div>
      ${needsBlock}
      ${p.current_state ? `<details class="mt-8"><summary class="text-label-sm text-on-surface-variant cursor-pointer select-none">Project state</summary><p class="mt-2 text-body-medium text-on-surface-variant whitespace-pre-wrap ${isChinese(p.current_state) ? "font-chinese" : ""}">${escapeHtml(clip(p.current_state, 1500))}</p></details>` : ""}
    </div>`;
}

// ── CONNECTIONS ───────────────────────────────────────────────────
function failingGmailMailboxes(msg) {
  const out = [], seen = new Set();
  for (const m of (msg || "").matchAll(/mailbox=([^\s:]+@[^\s:]+)/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

function renderConnections() {
  const s = App.state || { sourceErrors: {} };
  const errs = s.sourceErrors || {};
  const dotCls = { green: "bg-emerald-500", red: "bg-error", gray: "bg-slate-300" };
  const card = (name, detail, dot, sub, extra) => `
    <div class="bg-surface border border-outline rounded p-md flex items-start gap-sm">
      <span class="w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${dotCls[dot]}"></span>
      <div class="flex-1">
        <div class="text-body-medium text-on-surface">${escapeHtml(name)}</div>
        <div class="text-label-sm text-on-surface-variant">${escapeHtml(detail)}</div>
        ${sub ? `<div class="text-label-sm text-on-surface-variant opacity-70 mt-0.5">${escapeHtml(sub)}</div>` : ""}
        ${extra || ""}
      </div>
    </div>`;
  const slackErr = errs["slack:direct"];
  const gmailErr = errs["gmail:direct"];
  // One Reconnect button per Gmail mailbox whose token died — clicking spawns
  // the OAuth consent flow (opens the browser). Self-heals the daemon after.
  const gmailReauth = gmailErr
    ? `<div class="mt-2 flex flex-col gap-1 items-start">` +
      failingGmailMailboxes(gmailErr.message)
        .map(
          (mb) =>
            `<button class="reauth-btn text-label-sm text-primary border border-primary/40 bg-primary/5 rounded px-2 py-1 hover:bg-primary/10 transition-colors" data-mailbox="${escapeHtml(mb)}">Reconnect ${escapeHtml(mb)}</button>`,
        )
        .join("") +
      `</div>`
    : "";
  return `
    <header class="h-[60px] bg-surface border-b border-outline flex items-center px-lg flex-shrink-0">
      <h1 class="text-headline">Connections</h1>
    </header>
    <div class="flex-1 bg-background overflow-y-auto p-lg flex justify-center">
      <div class="w-full max-w-[640px] flex flex-col gap-sm">
        ${card(
          "Slack · Taiv",
          slackErr ? "token issue — cursor frozen, nothing lost" : "connected · direct API · IMs + group DMs",
          slackErr ? "red" : "green",
          "read · send (after approval)",
        )}
        ${card(
          "Gmail · 4 mailboxes",
          gmailErr ? "token expired — cursor frozen, nothing lost" : "connected · delta via historyId",
          gmailErr ? "red" : "green",
          "sending is draft-only by design — you press Send in Gmail",
          gmailReauth,
        )}
        ${card("Google Calendar", "connected · conflict-check before booking", "green", "read · create (after approval)")}
        ${card("WeChat", "manual — read via local decrypt, send by paste", "gray")}
        <div class="text-label-sm text-on-surface-variant mt-md leading-relaxed">
          Nothing is ever sent without your approval.<br />
          Behavior rules are fixed by design — there are no toggles.<br />
          Detection runs continuously; analysis happens only when something arrives.
        </div>
      </div>
    </div>`;
}

// ── action wiring ─────────────────────────────────────────────────
function wireScreen() {
  // rail
  document.querySelectorAll(".rail-btn").forEach((b) =>
    b.onclick = () => switchScreen(b.dataset.screen),
  );

  if (App.screen === "queue") {
    document.querySelectorAll(".task-card").forEach((r) => {
      r.onclick = () => { App.selectedTaskId = r.dataset.task; App.editCardId = null; App.editing = false; render(); };
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
    document.querySelectorAll(".row").forEach((r) =>
      r.onclick = () => selectCard(r.dataset.id),
    );
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
  } else if (App.screen === "projects") {
    document.querySelectorAll("[data-project]").forEach((el) =>
      el.onclick = () => { App.selectedProject = el.dataset.project; render(); },
    );
    // A card row jumps to the Queue with that card selected.
    document.querySelectorAll("[data-card]").forEach((el) =>
      el.onclick = () => { App.selectedId = el.dataset.card; switchScreen("queue"); },
    );
  } else if (App.screen === "people") {
    document.querySelectorAll(".contact-item").forEach((c) =>
      c.onclick = () => {
        App.selectedPerson = c.dataset.person;
        render();
      },
    );
    const more = document.querySelector(".contact-more");
    if (more) more.onclick = () => { App.showAllPeople = true; render(); };
  } else if (App.screen === "connections") {
    document.querySelectorAll(".reauth-btn").forEach((b) =>
      b.onclick = () => reauthGmail(b.dataset.mailbox, b),
    );
  }
}

async function reauthGmail(mailbox, btn) {
  if (btn) { btn.disabled = true; btn.textContent = `Opening browser for ${mailbox}…`; }
  try {
    const r = await apiPost("/api/connections/gmail/reauth", { mailbox });
    toast(r.detail || `Reconnecting ${mailbox}…`);
  } catch (e) {
    toast(e.message, true);
    if (btn) { btn.disabled = false; btn.textContent = `Reconnect ${mailbox}`; }
  }
}

function switchScreen(name) {
  App.screen = name;
  App.editing = false;
  if (name === "people" && !App.personas) {
    apiGet("/api/personas").then((d) => {
      App.personas = d.personas;
      render();
    });
  }
  if (name === "projects") {
    // Always refetch (cheap) so the Projects screen reflects the live queue.
    apiGet("/api/projects").then((d) => {
      App.projects = d;
      render();
    }).catch(() => {});
  }
  render();
}

function selectCard(id) {
  App.selectedId = id;
  App.editing = false;
  render();
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

function animateApprove(id) {
  const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.add("removing");
}

// ── keyboard ──────────────────────────────────────────────────────
function moveSelection(delta) {
  const ids = selectableIds();
  if (!ids.length) return;
  const idx = ids.indexOf(App.selectedId);
  const next = idx < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, idx + delta));
  selectCard(ids[next]);
  const row = document.querySelector(`.row[data-id="${CSS.escape(ids[next])}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  const k = e.key;
  if (App.gPrefix) {
    App.gPrefix = false;
    if (k === "q") switchScreen("queue");
    else if (k === "t") switchScreen("projects");
    else if (k === "p") switchScreen("people");
    else if (k === "c") switchScreen("connections");
    return;
  }
  if (k === "g") { App.gPrefix = true; return; }
  if (k === "?") { document.getElementById("help-sheet").hidden = false; return; }
  if (k === "Escape") { document.getElementById("help-sheet").hidden = true; App.editing = false; render(); return; }
  if (App.screen !== "queue") return;
  if (k === "j") { e.preventDefault(); moveSelection(1); }
  else if (k === "k") { e.preventDefault(); moveSelection(-1); }
  else if (k === "a") doAction("approve");
  else if (k === "e") doAction("edit");
  else if (k === "s") doAction("skip");
});

const helpSheet = document.getElementById("help-sheet");
document.getElementById("help-close").onclick = () => (helpSheet.hidden = true);
// Click anywhere on the backdrop (outside the card) closes the sheet.
helpSheet.onclick = (e) => {
  if (e.target === helpSheet) helpSheet.hidden = true;
};

// ── boot ──────────────────────────────────────────────────────────
(async function boot() {
  try {
    // auto-handle high-confidence task/ignore first so the queue is human-only
    await apiPost("/api/flush-auto", {}).catch(() => {});
    await refresh();
    // gentle poll for live updates (the daemon writes loop-state)
    setInterval(() => pollRefresh().catch(() => {}), 15000);
  } catch (e) {
    document.getElementById("screen").innerHTML =
      `<div class="detail-empty">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
})();
