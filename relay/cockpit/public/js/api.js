// api.js — fetch wrappers for the cockpit JSON API. The CSRF token comes from
// the <meta> the server injects into index.html; every POST echoes it back in
// the x-csrf-token header (relay/cockpit/security.ts rejects the request
// otherwise). Errors surface as thrown Error(message) with the server's
// `error` field — callers toast() them.

const CSRF = document.querySelector('meta[name="csrf-token"]').content;

export async function apiGet(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
export async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": CSRF },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
