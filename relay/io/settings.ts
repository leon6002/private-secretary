// Secretary settings — the non-secret, per-install preferences that the
// cockpit Settings screen edits and the daemon reads at startup
// (config/secretary-settings.json):
//
//   { "llm": { "mode": "cli" | "anthropic" | "deepseek", "draftModel": "opus" } }
//
// This file is NOT a secret — API keys and OAuth tokens never live here, they
// live in the macOS Keychain (relay/io/keychain.ts). It is still personal
// config (how THIS owner's instance runs), so it is gitignored like the rest
// of config/*.json — never commit it.
//
// Load is TOTAL: a missing file, corrupt JSON, or individually invalid fields
// all fall back to defaults — it never throws. Both readers (the daemon at
// startup, the cockpit on every Settings render) must survive a half-written
// or hand-mangled file; the next save simply rewrites it cleanly. Fallback is
// PER FIELD: one bad value doesn't discard the other valid ones.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LlmMode = "cli" | "anthropic" | "deepseek";

export interface SecretarySettings {
  llm: {
    mode: LlmMode;
    draftModel: string;
  };
}

export const LLM_MODES: readonly LlmMode[] = ["cli", "anthropic", "deepseek"];

export const DEFAULT_SETTINGS: SecretarySettings = {
  llm: { mode: "cli", draftModel: "opus" },
};

// settingsPathFor follows the same convention as CockpitApi.projectsDir():
// state/, config/ and projects/ are siblings under the repo root, so the
// config dir is two levels up from the state file.
export function settingsPathFor(statePath: string): string {
  return join(dirname(dirname(statePath)), "config", "secretary-settings.json");
}

// Read the settings file, tolerating every failure mode. Unknown extra fields
// are ignored (forward-compatible); invalid known fields fall back one by one.
export function loadSettings(statePath: string): SecretarySettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPathFor(statePath), "utf8")) as {
      llm?: { mode?: unknown; draftModel?: unknown };
    };
    const mode = raw?.llm?.mode;
    const draftModel = raw?.llm?.draftModel;
    return {
      llm: {
        mode: LLM_MODES.includes(mode as LlmMode) ? (mode as LlmMode) : DEFAULT_SETTINGS.llm.mode,
        draftModel:
          typeof draftModel === "string" && draftModel.trim()
            ? draftModel.trim()
            : DEFAULT_SETTINGS.llm.draftModel,
      },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

// Persist settings (mkdir -p first — a fresh clone has no config/ dir beyond
// the committed .example files, and the file may not exist yet).
export function saveSettings(statePath: string, settings: SecretarySettings): void {
  const path = settingsPathFor(statePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
