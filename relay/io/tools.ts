// User-configured MCP tools (config/tools.json). The cockpit Settings → Tools
// tab reads/writes this; the EFFECTIVE registry (built-in defaults merged with
// config) flows into missingInfo, the executor, the picker, and the LLM prompt.
//
// Like secretary-settings.json this is personal config — gitignored like the
// rest of config/*.json, never committed. Load is TOTAL: a missing/corrupt
// file falls back to the built-in defaults and never throws; the next save
// rewrites it cleanly. Fallback is PER FIELD.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TOOL_SPECS, mergeToolSpecs, type ToolSpec } from "../core/tool-registry.js";

export interface ToolsConfig {
  tools: Record<string, ToolSpec>;
}

// state/, config/ and projects/ are siblings under the repo root, so the
// config dir is two levels up from the state file (same as settings.ts).
export function toolsPathFor(statePath: string): string {
  return join(dirname(dirname(statePath)), "config", "tools.json");
}

export function loadToolsConfig(statePath: string): ToolsConfig {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(readFileSync(toolsPathFor(statePath), "utf8"));
  } catch {
    return { tools: {} }; // missing/corrupt → no overrides (built-ins still apply)
  }
  const tools: Record<string, ToolSpec> = {};
  const raw = (parsed as { tools?: unknown } | null)?.tools;
  if (raw && typeof raw === "object") {
    for (const [key, s] of Object.entries(raw as Record<string, unknown>)) {
      const spec = (s ?? {}) as Partial<ToolSpec>;
      tools[key] = {
        key,
        label: typeof spec.label === "string" && spec.label ? spec.label : key,
        requiredParams: Array.isArray(spec.requiredParams)
          ? spec.requiredParams.filter((p): p is string => typeof p === "string")
          : [],
        ...(spec.config && typeof spec.config === "object"
          ? { config: spec.config as Record<string, string> }
          : {}),
      };
    }
  }
  return { tools };
}

// Persist the config (mkdir -p first — a fresh clone has no config/ dir).
export function saveToolsConfig(statePath: string, config: ToolsConfig): void {
  const path = toolsPathFor(statePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

// The effective registry a card is validated / executed against: built-in
// defaults merged with the user's config overrides.
export function effectiveToolSpecs(statePath: string): Record<string, ToolSpec> {
  return mergeToolSpecs(DEFAULT_TOOL_SPECS, loadToolsConfig(statePath).tools);
}
