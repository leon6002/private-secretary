// connections.js — the Connections screen: one status card per source
// (Slack, Gmail, Calendar, WeChat) driven by /api/state's sourceErrors, with
// a per-mailbox Reconnect button when a Gmail OAuth refresh token dies.
// Self-contained: needs nothing from main.js.

import { App, escapeHtml, toast } from "./state.js";
import { apiPost } from "./api.js";

function failingGmailMailboxes(msg) {
  const out = [], seen = new Set();
  for (const m of (msg || "").matchAll(/mailbox=([^\s:]+@[^\s:]+)/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

export function renderConnections() {
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

export function wireConnections() {
  document.querySelectorAll(".reauth-btn").forEach((b) =>
    b.onclick = () => reauthGmail(b.dataset.mailbox, b),
  );
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
