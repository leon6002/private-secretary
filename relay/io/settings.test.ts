// settings.ts load/save: total fallback (missing/corrupt/invalid → defaults,
// never throws) + round-trip.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  machineTimeZone,
  saveSettings,
  settingsPathFor,
} from "./settings.js";

let dir: string;
let statePath: string;

beforeEach(() => {
  // statePath sits in <dir>/state/ so the config dir resolves to <dir>/config
  // (the state/config sibling convention).
  dir = mkdtempSync(join(tmpdir(), "settings-"));
  mkdirSync(join(dir, "state"), { recursive: true });
  statePath = join(dir, "state", "loop-state.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadSettings", () => {
  // timezone is resolved, not defaulted to a constant — an unset value means
  // "this machine", so it is compared separately from the static defaults.
  it("returns the defaults when the file is missing", () => {
    expect(loadSettings(statePath)).toEqual({ ...DEFAULT_SETTINGS, timezone: machineTimeZone() });
  });

  it("returns the defaults when the file is corrupt JSON", () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(settingsPathFor(statePath), "{ not json");
    expect(loadSettings(statePath)).toEqual({ ...DEFAULT_SETTINGS, timezone: machineTimeZone() });
  });

  it("falls back per field: an invalid mode defaults while a valid draftModel survives", () => {
    saveSettings(statePath, { llm: { mode: "anthropic", draftModel: "claude-opus-4-8" }, timezone: "Europe/Lisbon" });
    // Hand-mangle just the mode.
    writeFileSync(
      settingsPathFor(statePath),
      JSON.stringify({ llm: { mode: "wat", draftModel: "claude-opus-4-8" } }),
    );
    const s = loadSettings(statePath);
    expect(s.llm.mode).toBe("cli");
    expect(s.llm.draftModel).toBe("claude-opus-4-8");
  });

  it("ignores unknown extra fields", () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      settingsPathFor(statePath),
      JSON.stringify({ llm: { mode: "deepseek", draftModel: "deepseek-v4-pro" }, future: true }),
    );
    const s = loadSettings(statePath);
    expect(s.llm.mode).toBe("deepseek");
    expect(s.llm.draftModel).toBe("deepseek-v4-pro");
  });
});

describe("saveSettings", () => {
  it("round-trips and creates the config dir when absent", () => {
    const settings = {
      llm: { mode: "deepseek" as const, draftModel: "deepseek-v4-pro" },
      timezone: "Asia/Shanghai",
    };
    saveSettings(statePath, settings);
    expect(loadSettings(statePath)).toEqual(settings);
  });
});

describe("timezone", () => {
  // Unset must not mean UTC. Booking someone's meetings in the wrong zone is
  // the failure this whole area exists to prevent, so an absent value falls
  // back to the machine the daemon runs on.
  it("defaults to the machine's zone when unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-"));
    const state = join(dir, "state", "loop-state.json");
    expect(loadSettings(state).timezone).toBe(machineTimeZone());
  });

  it("keeps a valid configured zone", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-"));
    const state = join(dir, "state", "loop-state.json");
    saveSettings(state, { llm: { mode: "cli", draftModel: "opus" }, timezone: "Asia/Shanghai" });
    expect(loadSettings(state).timezone).toBe("Asia/Shanghai");
  });

  // An invented zone would make every conversion silently wrong.
  it("falls back to the machine when the configured zone is not real", () => {
    const dir = mkdtempSync(join(tmpdir(), "settings-"));
    const state = join(dir, "state", "loop-state.json");
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(
      join(dir, "config", "secretary-settings.json"),
      JSON.stringify({ llm: { mode: "cli", draftModel: "opus" }, timezone: "Portugal time" }),
    );
    expect(loadSettings(state).timezone).toBe(machineTimeZone());
  });
});
