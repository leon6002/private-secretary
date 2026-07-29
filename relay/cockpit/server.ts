// Cockpit HTTP server. Loopback-only, dependency-free (node:http). Serves
// the single-page UI + a small JSON API that drives CockpitApi. Security
// baseline (T8) enforced via security.ts on every request.
//
// Routes:
//   GET  /                       → index.html (CSRF token injected)
//   GET  /app.css, /app.js       → static assets
//   GET  /api/state              → CockpitState (queue, counts, gate, errors)
//   GET  /api/personas           → persona[] for the People screen
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
import { dirname, join } from "node:path";
import {
  CockpitApi,
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

export interface CockpitServerOptions extends CockpitApiOptions {
  port?: number; // default 4317
  host?: string; // default 127.0.0.1 — do NOT change to 0.0.0.0
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
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8").replace(
        "__CSRF_TOKEN__",
        csrfToken,
      );
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"], "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    if (method === "GET" && (path === "/app.css" || path === "/app.js")) {
      const ext = path.endsWith(".css") ? ".css" : ".js";
      const body = readFileSync(join(PUBLIC_DIR, path.slice(1)), "utf8");
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
    if (path === "/api/flush-auto" && method === "POST") {
      const n = await api.flushAutoExecute();
      sendJson(res, 200, { autoHandled: n });
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
