// Cockpit HTTP server. Loopback-only, dependency-free (node:http). Serves
// the single-page UI + a small JSON API that drives CockpitApi. Security
// baseline (T8) enforced via security.ts on every request.
//
// Routes:
//   GET  /                       → web/dist/index.html, the React app (CSRF token
//                                  injected; build-hint page when dist is missing)
//   GET  /index.html             → same as /
//   GET  /assets/**              → vite build output (hashed, immutable cache;
//                                  whitelisted extensions, contained in web/dist)
//   GET  /app.css, /js/**        → legacy vanilla SPA assets (.js/.css only,
//                                  contained in public/; removed in S6)
//   GET  /api/state              → CockpitState (queue, counts, gate, errors)
//   GET  /api/personas           → persona[] for the People screen
//   GET  /api/activity?tail=&kind= → activity-log tail (F3, read-only)
//   GET  /api/settings             → llm config + per-service key status (masked)
//   POST /api/settings/llm         → {mode, draftModel} → config file (daemon restart)
//   POST /api/settings/keys        → {service, value} → macOS Keychain (value never logged)
//   POST /api/actions/:id/approve   → approve + execute
//   POST /api/actions/:id/edit      → {draft?, params?}
//   POST /api/actions/:id/skip
//   POST /api/actions/:id/restore
//   POST /api/actions/:id/mark-sent → {ref?}  (awaiting-manual → executed)
//   POST /api/flush-auto             → auto-execute task/ignore ≥0.9
//
// The server NEVER mutates loop-state itself — every write goes through
// CockpitApi → relay/core + the lock.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import {
  CockpitApi,
  CockpitBadRequestError,
  CockpitBadStateError,
  CockpitBusyError,
  CockpitNotFoundError,
  type CockpitApiOptions,
} from "./api.js";
import { checkRequest, loadOrMintCsrfToken } from "./security.js";
import { startGmailReauth } from "./reauth.js";
import { InvalidActionTransition } from "../core/action-item.js";
import {
  EXISTENCE_VERDICTS,
  FIELD_ERRORS,
  type ExistenceVerdict,
  type FieldError,
} from "../io/labels.js";
import { ACTIVITY_KINDS, type ActivityKind } from "../io/activity-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
// The React app's build output (`npm run cockpit:build`). Served for "/" and
// "/assets/**"; the legacy public/ tree above keeps only its old routes until
// the migration finishes (S6).
const DEFAULT_WEB_DIST_DIR = join(__dirname, "web", "dist");

export interface CockpitServerOptions extends CockpitApiOptions {
  port?: number; // default 4317
  host?: string; // default 127.0.0.1 — do NOT change to 0.0.0.0
  // Overrides the web/dist location — tests point this at a temp fixture so
  // they never depend on a real build. Defaults to DEFAULT_WEB_DIST_DIR.
  webDistDir?: string;
}

export interface RunningCockpit {
  server: Server;
  port: number;
  url: string;
  csrfToken: string;
  close: () => Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

// Extensions servable from web/dist/assets — vite's hashed build output plus
// the static kinds the app references. Anything else (TS sources, configs…)
// is a 404 even if the file exists.
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// Served at "/" when the React app hasn't been built yet (fresh clone, or
// cockpit started before `npm run cockpit:build`). HTTP 200 with instructions,
// not an error — the API routes work regardless.
const BUILD_HINT_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>secretary</title></head>
<body style="font-family: ui-monospace, monospace; padding: 2rem; color: #1A1D21;">
<p>Cockpit web app is not built yet.</p>
<p>Run <code>npm run cockpit:build</code>, then reload this page.</p>
</body></html>`;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function errorStatus(e: unknown): { status: number; message: string } {
  if (e instanceof CockpitNotFoundError) return { status: 404, message: e.message };
  if (e instanceof CockpitBusyError) return { status: 409, message: e.message };
  if (e instanceof CockpitBadStateError) return { status: 409, message: e.message };
  if (e instanceof InvalidActionTransition) return { status: 400, message: e.message };
  if (e instanceof CockpitBadRequestError) return { status: 400, message: e.message };
  return { status: 500, message: (e as Error).message ?? "internal error" };
}

export function createCockpitServer(opts: CockpitServerOptions): {
  server: Server;
  csrfToken: string;
  host: string;
  port: number;
} {
  const api = new CockpitApi(opts);
  // Persisted in the state dir so a restart reuses the same token (open tabs
  // keep working instead of failing CSRF on the next approve).
  const csrfToken = loadOrMintCsrfToken(dirname(opts.statePath));
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4317;
  // resolve() up front so the /assets containment check below compares
  // absolute, normalized paths.
  const webDistDir = resolve(opts.webDistDir ?? DEFAULT_WEB_DIST_DIR);

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      const { status, message } = errorStatus(e);
      if (!res.headersSent) sendJson(res, status, { error: message });
    });
  });

  // The port to validate Host/Origin against — the ACTUAL bound port,
  // resolved at request time so port:0 (ephemeral, tests) works.
  function effectivePort(): number {
    const addr = server.address();
    return addr && typeof addr !== "string" ? addr.port : port;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const boundPort = effectivePort();
    const url = new URL(req.url ?? "/", `http://${host}:${boundPort}`);
    const path = url.pathname;

    // ── security gate (every request) ────────────────────────────
    const verdict = checkRequest({
      method,
      host: req.headers.host,
      origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      csrfHeader: typeof req.headers["x-csrf-token"] === "string"
        ? (req.headers["x-csrf-token"] as string)
        : undefined,
      expectedCsrf: csrfToken,
      port: boundPort,
    });
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.reason });
      return;
    }

    // ── static + index ──────────────────────────────────────────
    // The React app: web/dist/index.html with the CSRF token injected (same
    // mechanism as the legacy SPA — src/lib/api.ts reads the meta). no-store:
    // the token must never come from a cache. Missing dist → build hint.
    // replaceAll: a stray literal placeholder (e.g. in an HTML comment) must
    // never leave the <meta> itself uninjected.
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      let html: string;
      try {
        html = readFileSync(join(webDistDir, "index.html"), "utf8").replaceAll(
          "__CSRF_TOKEN__",
          csrfToken,
        );
      } catch {
        html = BUILD_HINT_HTML;
      }
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"], "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    // Vite build output. Filenames carry a content hash, so immutable caching
    // is safe (index.html above stays no-store and points at the new hashes
    // after each build). The resolved path must stay inside webDistDir (../
    // traversal rejected) and the extension must be whitelisted.
    if (method === "GET" && path.startsWith("/assets/")) {
      const file = resolve(webDistDir, "." + path);
      const contentType = ASSET_CONTENT_TYPES[extname(file)];
      if (!contentType || !file.startsWith(webDistDir + sep)) {
        sendJson(res, 404, { error: `no route: ${method} ${path}` });
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file); // binary-safe: .png/.woff2/.ico are servable
      } catch {
        sendJson(res, 404, { error: `no route: ${method} ${path}` });
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(body);
      return;
    }
    // Legacy vanilla SPA assets (public/), kept until the React migration
    // finishes (S6). The path is resolved against PUBLIC_DIR and must stay
    // inside it (../ traversal is rejected), and only .js/.css are ever
    // served — no HTML, no TS sources.
    if (method === "GET" && (path === "/app.css" || path.startsWith("/js/"))) {
      const file = resolve(PUBLIC_DIR, "." + path);
      const ext = extname(file);
      if ((ext !== ".js" && ext !== ".css") || !file.startsWith(PUBLIC_DIR + sep)) {
        sendJson(res, 404, { error: `no route: ${method} ${path}` });
        return;
      }
      let body: string;
      try {
        body = readFileSync(file, "utf8");
      } catch {
        sendJson(res, 404, { error: `no route: ${method} ${path}` });
        return;
      }
      // no-store so a plain reload always picks up edits (local dev tool;
      // there's no CDN to benefit from caching anyway).
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext]!, "Cache-Control": "no-store" });
      res.end(body);
      return;
    }

    // ── API ──────────────────────────────────────────────────────
    if (path === "/api/state" && method === "GET") {
      sendJson(res, 200, api.getState());
      return;
    }
    if (path === "/api/personas" && method === "GET") {
      sendJson(res, 200, { personas: api.getPeople() });
      return;
    }
    if (path === "/api/projects" && method === "GET") {
      sendJson(res, 200, api.getProjects());
      return;
    }
    // F3 activity log (read-only): the engine's operational trail for the
    // Activity screen. ?kind= is validated against the known kinds; ?tail=
    // is capped inside getActivity.
    if (path === "/api/activity" && method === "GET") {
      const tailParam = Number(url.searchParams.get("tail") ?? "100");
      const kindParam = url.searchParams.get("kind");
      const kind = kindParam && ACTIVITY_KINDS.has(kindParam) ? (kindParam as ActivityKind) : undefined;
      sendJson(res, 200, api.getActivity({
        tail: Number.isFinite(tailParam) ? tailParam : 100,
        ...(kind ? { kind } : {}),
      }));
      return;
    }
    if (path === "/api/flush-auto" && method === "POST") {
      const n = await api.flushAutoExecute();
      sendJson(res, 200, { autoHandled: n });
      return;
    }

    // Settings screen (S3). Read is free-form; both writes validate the body
    // here (shape) and inside CockpitApi (enum/whitelist → 400). Key values
    // pass straight through to the Keychain — they are never logged.
    if (path === "/api/settings" && method === "GET") {
      sendJson(res, 200, await api.getSettings());
      return;
    }
    if (path === "/api/settings/llm" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (typeof body.mode !== "string" || typeof body.draftModel !== "string") {
        sendJson(res, 400, { error: "mode and draftModel (strings) required" });
        return;
      }
      sendJson(res, 200, api.setLlm({ mode: body.mode, draftModel: body.draftModel }));
      return;
    }
    if (path === "/api/settings/keys" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      if (typeof body.service !== "string" || typeof body.value !== "string") {
        sendJson(res, 400, { error: "service and value (strings) required" });
        return;
      }
      sendJson(res, 200, await api.setApiKey({ service: body.service, value: body.value }));
      return;
    }

    // Re-authorize a Gmail mailbox whose refresh_token expired (the Connections
    // "Reconnect" button). Spawns the consent flow (opens the browser); the
    // daemon picks up the fresh token on its next tick.
    if (path === "/api/connections/gmail/reauth" && method === "POST") {
      const body = (await readBody(req)) as Record<string, unknown>;
      const mailbox = typeof body.mailbox === "string" ? body.mailbox.trim() : "";
      if (!mailbox) {
        sendJson(res, 400, { error: "mailbox required" });
        return;
      }
      const result = await startGmailReauth(mailbox);
      sendJson(res, result.started ? 200 : 400, result);
      return;
    }

    const actionMatch = path.match(/^\/api\/actions\/([^/]+)\/([a-z-]+)$/);
    if (actionMatch && method === "POST") {
      const id = decodeURIComponent(actionMatch[1]!);
      const op = actionMatch[2]!;
      const body = (await readBody(req)) as Record<string, unknown>;
      switch (op) {
        case "approve":
          sendJson(res, 200, await api.approve(id));
          return;
        case "edit":
          sendJson(res, 200, {
            action: api.edit(id, {
              draft: typeof body.draft === "string" ? body.draft : undefined,
              params: typeof body.params === "object" && body.params !== null
                ? (body.params as Record<string, unknown>)
                : undefined,
            }),
          });
          return;
        case "skip": {
          // P0 typed skip: the reason is the whole point of the埋点. Validated
          // against the enums so a stray UI value can't poison the ledger.
          const existence =
            typeof body.existence === "string" && EXISTENCE_VERDICTS.has(body.existence)
              ? (body.existence as ExistenceVerdict)
              : undefined;
          const field_errors = Array.isArray(body.field_errors)
            ? body.field_errors.filter(
                (f): f is FieldError => typeof f === "string" && FIELD_ERRORS.has(f),
              )
            : undefined;
          sendJson(res, 200, {
            action: api.skip(id, {
              existence,
              field_errors,
              note: typeof body.note === "string" ? body.note.slice(0, 500) : undefined,
            }),
          });
          return;
        }
        case "done":
          sendJson(res, 200, { action: api.markDone(id) });
          return;
        case "restore":
          sendJson(res, 200, { action: api.restore(id) });
          return;
        case "mark-sent":
          sendJson(res, 200, {
            action: api.markSent(id, typeof body.ref === "string" ? body.ref : undefined),
          });
          return;
        default:
          sendJson(res, 404, { error: `unknown op: ${op}` });
          return;
      }
    }

    // Manual tier override: drag a task to another A/B/C/D section. tier null/""
    // clears the override (back to the AI ranking).
    const tierMatch = path.match(/^\/api\/tasks\/([^/]+)\/tier$/);
    if (tierMatch && method === "POST") {
      const key = decodeURIComponent(tierMatch[1]!);
      const body = (await readBody(req)) as Record<string, unknown>;
      const tier = typeof body.tier === "string" && ["A", "B", "C", "D"].includes(body.tier)
        ? (body.tier as "A" | "B" | "C" | "D")
        : null;
      sendJson(res, 200, api.setTier(key, tier));
      return;
    }

    sendJson(res, 404, { error: `no route: ${method} ${path}` });
  }

  return { server, csrfToken, host, port };
}

// Start + bind. Resolves once listening so callers (and tests) get the
// real port (0 → ephemeral).
export async function startCockpit(opts: CockpitServerOptions): Promise<RunningCockpit> {
  const { server, csrfToken, host, port } = createCockpitServer(opts);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const boundPort = addr && typeof addr !== "string" ? addr.port : port;
  const url = `http://${host}:${boundPort}`;
  return {
    server,
    port: boundPort,
    url,
    csrfToken,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
