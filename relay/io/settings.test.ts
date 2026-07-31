// settings.ts load/save: total fallback (missing/corrupt/invalid → defaults,
// never throws) + round-trip.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  loadSettings,
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
  it("returns the defaults when the file is missing", () => {
    expect(loadSettings(statePath)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults when the file is corrupt JSON", () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(settingsPathFor(statePath), "{ not json");
    expect(loadSettings(statePath)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back per field: an invalid mode defaults while a valid draftModel survives", () => {
    saveSettings(statePath, { llm: { mode: "anthropic", draftModel: "claude-opus-4-8" } });
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
    const settings = { llm: { mode: "deepseek" as const, draftModel: "deepseek-v4-pro" } };
    saveSettings(statePath, settings);
    expect(loadSettings(statePath)).toEqual(settings);
  });
});
