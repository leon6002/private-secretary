// projects.js — the Projects screen (Microsoft To-Do style): a sidebar of
// projects grouped by company plus a Misc catch-all, and a main pane with the
// project's open cards, needs/gaps, and (collapsed) current state. Clicking a
// card jumps to the Queue with that card selected. Render-only; render() and
// switchScreen() live in main.js (circular import via live bindings, called
// at runtime only).

import { App, clip, escapeHtml, isChinese } from "./state.js";
import { render, switchScreen } from "./main.js";

const COMPANY_LABEL = {
  oushikesi: "欧思克斯 · OUS",
  osyx: "OSYX",
  taiv: "Taiv",
  tool: "Tools",
  tools: "Tools",
};

export function renderProjects() {
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

export function wireProjects() {
  document.querySelectorAll("[data-project]").forEach((el) =>
    el.onclick = () => { App.selectedProject = el.dataset.project; render(); },
  );
  // A card row jumps to the Queue with that card selected.
  document.querySelectorAll("[data-card]").forEach((el) =>
    el.onclick = () => { App.selectedId = el.dataset.card; switchScreen("queue"); },
  );
}
