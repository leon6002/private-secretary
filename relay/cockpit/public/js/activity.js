// activity.js — the Activity screen (F3): a read-only tail of the engine's
// activity log (ticks, supersedes, auto-executes, cockpit decisions, errors)
// with kind filter chips. Newest first. Data: GET /api/activity, refetched
// on entry / chip click / the 15s poll (via loadActivity in main.js).

import { App, escapeHtml, timeAgo } from "./state.js";
import { apiGet } from "./api.js";
import { render } from "./main.js";

const KINDS = ["tick", "supersede", "auto-execute", "approve", "skip", "edit", "restore", "mark-done", "error"];

// Kind chip colors stay inside the DESIGN.md palette: neutral hairline chips,
// red only for errors, the primary blue for the human's own decisions.
const KIND_TONE = {
  error: "text-error border-error/40",
  approve: "text-primary border-primary/40",
  "auto-execute": "text-amber-600 border-amber-500/40",
};

function chip(label, value) {
  const active = (App.activityKind ?? "") === value;
  return `<button class="activity-chip text-label-sm rounded border px-2 py-0.5 transition-colors ${
    active
      ? "border-primary text-primary bg-primary/5"
      : "border-outline text-on-surface-variant hover:text-on-surface"
  }" data-kind="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

function row(r) {
  const tone = KIND_TONE[r.kind] ?? "text-on-surface-variant border-outline";
  // Error ticks carry the failing sources' messages in data.errors — that's
  // the actual diagnostic, surface it under the summary.
  const errDetail = r.data?.errors
    ? Object.values(r.data.errors)
        .map((m) => `<div class="text-label-sm text-error/80 mt-0.5">${escapeHtml(m)}</div>`)
        .join("")
    : "";
  return `
    <div class="bg-surface border border-outline rounded px-md py-sm flex items-baseline gap-md">
      <span class="text-label-sm text-on-surface-variant w-[64px] flex-shrink-0" title="${escapeHtml(r.at)}">${escapeHtml(timeAgo(r.at))}</span>
      <span class="text-label-xs rounded border px-1.5 py-0.5 flex-shrink-0 ${tone}">${escapeHtml(r.kind)}</span>
      <span class="text-body-base text-on-surface min-w-0 break-words">${escapeHtml(r.summary)}${errDetail}</span>
    </div>`;
}

export function renderActivity() {
  const recs = [...(App.activity?.records ?? [])].reverse(); // newest first
  return `
    <header class="h-[60px] bg-surface border-b border-outline flex items-center gap-md px-lg flex-shrink-0">
      <h1 class="text-headline">Activity</h1>
      <div class="flex gap-1.5 flex-wrap">
        ${chip("all", "")}
        ${KINDS.map((k) => chip(k, k)).join("")}
      </div>
    </header>
    <div class="flex-1 bg-background overflow-y-auto p-lg flex justify-center" data-scroll="activity-main">
      <div class="w-full max-w-[860px] flex flex-col gap-1.5">
        ${recs.length === 0
          ? `<div class="text-body-base text-on-surface-variant py-xl text-center">nothing yet — the log fills as the daemon scans and you triage</div>`
          : recs.map(row).join("")}
      </div>
    </div>`;
}

export function wireActivity() {
  document.querySelectorAll(".activity-chip").forEach((b) =>
    b.onclick = () => {
      App.activityKind = b.dataset.kind || null;
      loadActivity();
    },
  );
}

// Refetch the log and re-render only when it actually changed (the 15s poll
// calls this too — a no-op fetch must not churn the screen).
export async function loadActivity() {
  const kind = App.activityKind;
  try {
    const d = await apiGet(`/api/activity?tail=200${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`);
    const sig = d.records?.length ? d.records[d.records.length - 1].at + ":" + d.records.length : "empty";
    App.activity = d;
    if (sig !== App.activitySig) {
      App.activitySig = sig;
      render();
    }
  } catch {
    /* a failed poll keeps the last good render */
  }
}
