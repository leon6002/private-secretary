// state.js — the single App state object every screen reads/writes, plus the
// pure (or near-pure) helpers they all share: HTML escaping, avatar chips,
// language detection, relative time, text clipping, and the toast. Rendering
// and fetch orchestration live in main.js; this module never imports them.

// ── app state ─────────────────────────────────────────────────────
export const App = {
  screen: "queue",
  state: null, // /api/state payload
  personas: null, // persona[]
  selectedId: null, // card being acted on (per-row / footer / edit / keyboard)
  selectedTaskId: null, // selected task in Today — drives the detail pane
  editCardId: null, // when set, Today detail drills into this card's editor
  skipFor: null, // when set, that card's footer shows the typed-skip reason picker
  selectedPerson: null, // selected persona key in People
  showAllPeople: false, // People rail: expand past the "+N" overflow chip
  projects: null, // /api/projects payload {projects, misc}
  selectedProject: null, // selected project id in Projects (or "__misc")
  activity: null, // /api/activity payload {records}
  activityKind: null, // Activity screen kind filter (null = all)
  activitySig: null, // change signature of the last fetched activity tail
  editing: false, // draft edit mode in detail pane
  gPrefix: false, // "g" chord pending
};

// Signature of the parts that affect the rendered UI — used to skip needless
// re-renders on the poll (so the page doesn't churn every 15s).
export function stateSig(s) {
  if (!s) return "";
  const parts = [JSON.stringify(s.counts)];
  for (const c of s.clusters || []) for (const a of c.actions || []) parts.push(a.id + ":" + a.status);
  for (const a of s.awaitingManual || []) parts.push("am:" + a.id);
  for (const a of s.done || []) parts.push("d:" + a.id);
  for (const a of s.skipped || []) parts.push("k:" + a.id);
  return parts.join("|");
}

// ── util ──────────────────────────────────────────────────────────
export function hueFromKey(key) {
  let h = 0;
  for (const ch of key || "?") h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export function avatar(label, key, size = 24, photo) {
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
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
export function isChinese(s) {
  return /[一-鿿]/.test(s || "");
}
export function toast(msg, isErr) {
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
export function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
export function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
