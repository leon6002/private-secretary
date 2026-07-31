// Fetch wrappers for the cockpit JSON API — the React port of the legacy
// public/js/api.js. The CSRF token comes from the <meta> the server injects
// into index.html (relay/cockpit/server.ts replaces __CSRF_TOKEN__ when
// serving the page); every POST echoes it back in the x-csrf-token header or
// relay/cockpit/security.ts rejects the request. Errors surface as thrown
// Error(message) carrying the server's `error` field.
//
// Imports in this app are extensionless (bundler-style): vite resolves them,
// and web/tsconfig.json uses moduleResolution "Bundler". The repo's .js-suffix
// convention is for Node-executed TS, which this app is not.

function csrfToken(): string {
  // Read at call time, not module load: the meta is injected by the server
  // and tests may swap the document between cases.
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || r.statusText);
  return (await r.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken() },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data as T;
}
