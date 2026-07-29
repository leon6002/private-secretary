import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpit, type RunningCockpit } from "./server.js";
import type { CockpitExecutor } from "./api.js";
import { markExecuted, withReceipt, type ActionItem } from "../core/action-item.js";
import { loadState } from "../io/state.js";

let dir: string;
let statePath: string;
let personaDir: string;
let cockpit: RunningCockpit;

function action(over: Partial<ActionItem> = {}): ActionItem {
  return {
    id: "a1",
    source_message_id: "slack:C1:1781000000.0001",
    action_type: "reply",
    target: { platform: "slack", personaKey: "michael-dobosz" },
    reason: "answer",
    confidence: 0.95,
    params: {},
    draft: "sounds good",
    status: "suggested",
    created_at: "2026-06-14T00:00:00Z",
    context: { sender_handle: "U_MICHAEL", original_message: "you free?" },
    ...over,
  };
}

const sendingExecutor: CockpitExecutor = async (a) => {
  const receipt = { kind: "sent" as const, ref: "https://slack/x", at: "t" };
  return { ok: true, action: markExecuted(withReceipt(a, receipt)), receipt, awaitingManual: false };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-srv-"));
  statePath = join(dir, "loop-state.json");
  personaDir = join(dir, "personas");
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify({ version: 2, marks: {}, actions: [action()], outcomes: [], sourceErrors: {}, tasks: {} }),
  );
  cockpit = await startCockpit({ statePath, personaDir, executor: sendingExecutor, port: 0 });
});

afterEach(async () => {
  await cockpit.close();
  rmSync(dir, { recursive: true, force: true });
});

function url(path: string): string {
  return `${cockpit.url}${path}`;
}

describe("cockpit HTTP server", () => {
  it("GET / serves the SPA with the CSRF token injected", async () => {
    const r = await fetch(url("/"));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(cockpit.csrfToken);
    expect(html).not.toContain("__CSRF_TOKEN__");
    expect(html).toContain('data-screen="queue"'); // SPA shell: the nav rail is served
  });

  it("GET /app.css and /app.js serve static assets", async () => {
    const css = await fetch(url("/app.css"));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    const js = await fetch(url("/app.js"));
    expect(js.status).toBe(200);
  });

  it("GET /api/state returns the seeded queue", async () => {
    const r = await fetch(url("/api/state"));
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.counts.pending).toBe(1);
    expect(s.suggested[0].id).toBe("a1");
  });

  it("POST without CSRF token → 403", async () => {
    const r = await fetch(url("/api/actions/a1/approve"), { method: "POST" });
    expect(r.status).toBe(403);
    // unchanged on disk
    expect(loadState(statePath).actions[0]!.status).toBe("suggested");
  });

  it("POST with valid CSRF approves + executes", async () => {
    const r = await fetch(url("/api/actions/a1/approve"), {
      method: "POST",
      headers: { "x-csrf-token": cockpit.csrfToken, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    const res = await r.json();
    expect(res.ok).toBe(true);
    expect(loadState(statePath).actions[0]!.status).toBe("executed");
  });

  it("POST from a foreign Host header → 403 (DNS-rebind guard)", async () => {
    // fetch() refuses to set a custom Host header (forbidden header name),
    // so use raw http to actually send "evil.example.com".
    const http = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: cockpit.port,
          path: "/api/actions/a1/skip",
          method: "POST",
          headers: { Host: "evil.example.com", "x-csrf-token": cockpit.csrfToken },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("edit via POST patches the draft", async () => {
    const r = await fetch(url("/api/actions/a1/edit"), {
      method: "POST",
      headers: { "x-csrf-token": cockpit.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ draft: "edited body" }),
    });
    expect(r.status).toBe(200);
    expect(loadState(statePath).actions[0]!.draft).toBe("edited body");
  });

  it("approve on a missing-info card → 400", async () => {
    // overwrite with a draftless reply
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2, marks: {},
        actions: [action({ draft: "" })],
        outcomes: [], sourceErrors: {}, tasks: {},
      }),
    );
    const r = await fetch(url("/api/actions/a1/approve"), {
      method: "POST",
      headers: { "x-csrf-token": cockpit.csrfToken, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(400);
  });

  it("unknown route → 404", async () => {
    const r = await fetch(url("/api/nope"));
    expect(r.status).toBe(404);
  });
});
