// The request validator is the security boundary here: everything it accepts
// is written verbatim into a generated shell script, so it whitelists rather
// than escapes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapPrompt,
  bootstrapState,
  InvalidBootstrapRequest,
  startPersonaBootstrap,
  validateRequest,
} from "./persona-bootstrap.js";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  statePath = join(dir, "state", "loop-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("validateRequest", () => {
  it("accepts the skill's three contact selectors", () => {
    expect(validateRequest({ contacts: "top:20" }).contacts).toBe("top:20");
    expect(validateRequest({ contacts: "all" }).contacts).toBe("all");
    expect(validateRequest({ contacts: "leo,sandro.pinto" }).contacts).toBe("leo,sandro.pinto");
  });

  it("defaults to top:20 over 5 years, generating nothing extra", () => {
    expect(validateRequest({})).toEqual({ contacts: "top:20", historyYears: 5, dryRun: false });
  });

  // These end up in a shell script. A rejected request is the only safe answer.
  it.each([
    "top:20; rm -rf ~",
    "$(whoami)",
    "`id`",
    "a b",
    "leo,../../etc/passwd",
    "",
  ])("rejects %j rather than trying to quote it", (bad) => {
    expect(() => validateRequest({ contacts: bad })).toThrow(InvalidBootstrapRequest);
  });

  it.each([0, -1, 21, 1.5, Number.NaN])("rejects %s years", (bad) => {
    expect(() => validateRequest({ historyYears: bad })).toThrow(InvalidBootstrapRequest);
  });
});

describe("bootstrapPrompt", () => {
  it("is the skill's documented invocation", () => {
    expect(bootstrapPrompt({ contacts: "top:5", historyYears: 2, dryRun: false })).toBe(
      "bootstrap personas --contacts top:5 --history-years 2",
    );
  });

  it("passes --dry-run through, since that is the no-cost path", () => {
    expect(bootstrapPrompt({ contacts: "all", historyYears: 5, dryRun: true })).toBe(
      "bootstrap personas --contacts all --history-years 5 --dry-run",
    );
  });
});

describe("startPersonaBootstrap", () => {
  it("writes an executable launcher and opens it", () => {
    const calls: Array<[string, string[]]> = [];
    const r = startPersonaBootstrap(
      statePath,
      { contacts: "top:3", historyYears: 1, dryRun: false },
      (file, args) => calls.push([file, args]),
    );
    expect(calls).toEqual([["open", [r.launcher]]]);
    const script = readFileSync(r.launcher, "utf8");
    expect(script).toContain("exec claude");
    expect(script).toContain("bootstrap personas --contacts top:3 --history-years 1");
  });
});

describe("bootstrapState", () => {
  it("reports not-started when no run has ever initialized a ledger", () => {
    expect(bootstrapState(statePath)).toEqual({
      started: false,
      counts: { pending: 0, staged: 0, promoted: 0, failed: 0 },
      total: 0,
    });
  });

  // The ledger is written by the skill, not by us — reading it is the only way
  // the cockpit knows anything about a run it does not host.
  it("summarizes a ledger the skill wrote", () => {
    writeFileSync(
      join(dir, "state", "bootstrap-progress.json"),
      JSON.stringify({
        params: { contacts: "top:2", history_years: 5 },
        contacts: {
          leo: { key: "leo", status: "promoted", updated_at: "2026-08-10T00:00:00Z" },
          sandro: { key: "sandro", status: "pending", updated_at: "2026-08-10T00:00:00Z" },
        },
      }),
    );
    expect(bootstrapState(statePath)).toMatchObject({
      started: true,
      total: 2,
      counts: { promoted: 1, pending: 1 },
    });
  });
});
