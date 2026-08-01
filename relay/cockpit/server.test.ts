import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCockpit, type RunningCockpit } from "./server.js";
import type { CockpitExecutor } from "./api.js";
import { markExecuted, withReceipt, type ActionItem } from "../core/action-item.js";
import { loadState } from "../io/state.js";
import { appendActivity, activityPathFor } from "../io/activity-log.js";
import { __setRunner } from "../io/keychain.js";

let dir: string;
let statePath: string;
let personaDir: string;
let webDistDir: string;
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
  // A stand-in for the vite build output (relay/cockpit/web/dist) so these
  // tests never depend on a real `npm run cockpit:build`. index.html carries
  // the same __CSRF_TOKEN__ placeholder the real one does.
  webDistDir = join(dir, "web-dist");
  mkdirSync(join(webDistDir, "assets"), { recursive: true });
  writeFileSync(
    join(webDistDir, "index.html"),
    '<!DOCTYPE html><html><head><meta name="csrf-token" content="__CSRF_TOKEN__" /></head>' +
      '<body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body></html>',
  );
  writeFileSync(join(webDistDir, "assets", "index-abc123.js"), 'console.log("fixture");\n');
  // A .ts file inside assets: exists on disk but must NOT be served
  // (extension whitelist).
  writeFileSync(join(webDistDir, "assets", "source-leak.ts"), "export {};\n");
  writeFileSync(
    statePath,
    JSON.stringify({ version: 2, marks: {}, actions: [action()], outcomes: [], sourceErrors: {}, tasks: {} }),
  );
  cockpit = await startCockpit({ statePath, personaDir, executor: sendingExecutor, port: 0, webDistDir });
});

afterEach(async () => {
  await cockpit.close();
  rmSync(dir, { recursive: true, force: true });
});

function url(path: string): string {
  return `${cockpit.url}${path}`;
}

describe("cockpit HTTP server", () => {
  it("GET / serves the built React app with the CSRF token injected", async () => {
    const r = await fetch(url("/"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain(cockpit.csrfToken);
    expect(html).not.toContain("__CSRF_TOKEN__");
    expect(html).toContain('<div id="root">'); // the React mount point from web/dist
  });

  it("GET / without a built web/dist serves the build-hint page (200)", async () => {
    const alt = await startCockpit({
      statePath,
      personaDir,
      executor: sendingExecutor,
      port: 0,
      webDistDir: join(dir, "no-such-dist"),
    });
    try {
      const r = await fetch(`${alt.url}/`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain("npm run cockpit:build");
    } finally {
      await alt.close();
    }
  });

  it("GET /assets/* serves hashed build output with immutable caching", async () => {
    const r = await fetch(url("/assets/index-abc123.js"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/javascript/);
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await r.text()).toContain("fixture");
  });

  it("GET /assets rejects non-whitelisted extensions even when the file exists", async () => {
    const r = await fetch(url("/assets/source-leak.ts"));
    expect(r.status).toBe(404);
  });

  it("GET /assets traversal is rejected", async () => {
    // fetch() normalizes dot segments away client-side, so send the raw path.
    const http = await import("node:http");
    for (const path of ["/assets/../server.ts", "/assets/%2e%2e/%2e%2e/server.ts"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: cockpit.port, path, method: "GET" },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404);
    }
  });

  it("legacy vanilla SPA routes are gone (public/ deleted in S6)", async () => {
    for (const p of ["/app.css", "/js/main.js"]) {
      const r = await fetch(url(p));
      expect(r.status, p).toBe(404);
    }
  });

  it("GET /api/state returns the seeded queue", async () => {
    const r = await fetch(url("/api/state"));
    expect(r.status).toBe(200);
    const s = await r.json();
    expect(s.counts.pending).toBe(1);
    expect(s.suggested[0].id).toBe("a1");
  });

  it("GET /api/activity returns the log tail; a bogus ?kind= is ignored", async () => {
    appendActivity(activityPathFor(statePath), { at: "2026-07-31T10:00:00.000Z", kind: "tick", summary: "t" });
    appendActivity(activityPathFor(statePath), { at: "2026-07-31T10:01:00.000Z", kind: "skip", summary: "s" });
    const all = await (await fetch(url("/api/activity"))).json();
    expect(all.records.map((r: { kind: string }) => r.kind)).toEqual(["tick", "skip"]);
    const filtered = await (await fetch(url("/api/activity?kind=skip"))).json();
    expect(filtered.records.map((r: { kind: string }) => r.kind)).toEqual(["skip"]);
    const bogus = await (await fetch(url("/api/activity?kind=nope"))).json();
    expect(bogus.records).toHaveLength(2); // unknown kind = no filter, not empty
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

// Settings routes (S3). The Keychain runner is stubbed so GET /api/settings
// never probes the real login keychain. These tests run their OWN cockpit
// with the state file in a nested state/ dir: settingsPathFor() resolves the
// config dir two levels up from the state file, so the shared root-level
// statePath would resolve the config into the SHARED $TMPDIR and leak
// settings between tests (and test files).
describe("settings routes", () => {
  let settingsCockpit: RunningCockpit;

  beforeEach(async () => {
    __setRunner(async () => {
      const err = new Error("not found") as Error & { code?: number };
      err.code = 44;
      throw err;
    });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const nestedStatePath = join(dir, "state", "loop-state.json");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(
      nestedStatePath,
      JSON.stringify({ version: 2, marks: {}, actions: [], outcomes: [], sourceErrors: {}, tasks: {} }),
    );
    settingsCockpit = await startCockpit({
      statePath: nestedStatePath,
      personaDir,
      executor: sendingExecutor,
      port: 0,
      webDistDir,
    });
  });
  afterEach(async () => {
    __setRunner(null);
    await settingsCockpit.close();
  });

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${settingsCockpit.url}${path}`, {
      method: "POST",
      headers: { "x-csrf-token": settingsCockpit.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("GET /api/settings → 200 with masked key status", async () => {
    const r = await fetch(`${settingsCockpit.url}/api/settings`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      llm: { mode: string; draftModel: string };
      keys: Record<string, { configured: boolean; preview: string | null }>;
    };
    expect(body.llm).toEqual({ mode: "cli", draftModel: "opus" });
    expect(body.keys.anthropic).toEqual({ configured: false, preview: null });
    expect(body.keys.deepseek).toEqual({ configured: false, preview: null });
  });

  it("POST /api/settings/llm with an invalid mode → 400; valid → 200 + restartRequired", async () => {
    const bad = await post("/api/settings/llm", { mode: "wat", draftModel: "opus" });
    expect(bad.status).toBe(400);
    const missing = await post("/api/settings/llm", { mode: "cli" });
    expect(missing.status).toBe(400);
    const ok = await post("/api/settings/llm", { mode: "deepseek", draftModel: "deepseek-v4-pro" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { restartRequired?: boolean }).restartRequired).toBe(true);
  });

  it("POST /api/settings/keys with an unknown service → 400", async () => {
    const r = await post("/api/settings/keys", { service: "slack", value: "xoxp-1" });
    expect(r.status).toBe(400);
    const missing = await post("/api/settings/keys", { service: "anthropic" });
    expect(missing.status).toBe(400);
  });
});
