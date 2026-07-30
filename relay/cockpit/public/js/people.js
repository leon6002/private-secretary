// people.js — the People screen: a compact contact rail (first 5 + a "+N"
// overflow chip) and the full persona profile (core knowledge with hover
// evidence, voice & style, active tasks, commitments, open threads). Render-
// only; render() lives in main.js (circular import via live bindings, called
// at runtime only).

import { App, avatar, clip, escapeHtml, isChinese } from "./state.js";
import { render } from "./main.js";

export function renderPeople() {
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

export function wirePeople() {
  document.querySelectorAll(".contact-item").forEach((c) =>
    c.onclick = () => {
      App.selectedPerson = c.dataset.person;
      render();
    },
  );
  const more = document.querySelector(".contact-more");
  if (more) more.onclick = () => { App.showAllPeople = true; render(); };
}
