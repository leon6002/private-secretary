// main.js — the cockpit SPA entry point (loaded as <script type="module">).
// Owns the cross-screen machinery: data load + the 15s poll, the render
// dispatch with scroll memory, screen switching, the global keydown listener,
// the help sheet, and boot. Screen rendering/interactions live in queue.js /
// projects.js / people.js / connections.js — those import render()/refresh()
// back from here, a deliberate circular import that is safe because every
// cross-module call happens at runtime, never during module evaluation.

import { apiGet, apiPost } from "./api.js";
import { App, escapeHtml, stateSig } from "./state.js";
import { keyboardAction, moveSelection, renderQueue, wireQueue } from "./queue.js";
import { renderProjects, wireProjects } from "./projects.js";
import { renderPeople, wirePeople } from "./people.js";
import { renderConnections, wireConnections } from "./connections.js";

// ── data load ─────────────────────────────────────────────────────
export async function refresh() {
  App.state = await apiGet("/api/state");
  updateBadge();
  render();
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
export function render() {
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

// ── screen switching + event wiring ───────────────────────────────
function wireScreen() {
  // rail
  document.querySelectorAll(".rail-btn").forEach((b) =>
    b.onclick = () => switchScreen(b.dataset.screen),
  );

  if (App.screen === "queue") wireQueue();
  else if (App.screen === "projects") wireProjects();
  else if (App.screen === "people") wirePeople();
  else if (App.screen === "connections") wireConnections();
}

export function switchScreen(name) {
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

// ── keyboard ──────────────────────────────────────────────────────
// j/k move the selected TASK (moveSelection in queue.js keeps the detail pane
// and the acted-on card in lockstep); a/e/s act on that task's footer targets.
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
  else if (k === "a") keyboardAction("approve");
  else if (k === "e") keyboardAction("edit");
  else if (k === "s") keyboardAction("skip");
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
