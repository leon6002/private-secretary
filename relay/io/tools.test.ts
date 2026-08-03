import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToolsConfig, saveToolsConfig, effectiveToolSpecs, toolsPathFor } from "./tools.js";
import { DEFAULT_TOOL_SPECS } from "../core/tool-registry.js";

let dir: string;
let statePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tools-"));
  statePath = join(dir, "state", "loop-state.json");
  mkdirSync(join(dir, "config"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tools config (config/tools.json)", () => {
  it("missing config → no overrides, effective = built-in defaults", () => {
    expect(loadToolsConfig(statePath).tools).toEqual({});
    expect(effectiveToolSpecs(statePath)).toEqual(DEFAULT_TOOL_SPECS);
  });

  it("save + load round-trips and sanitizes per field", () => {
    saveToolsConfig(statePath, {
      tools: {
        notion: { key: "notion", label: "Notion", requiredParams: ["title", "content"] },
      },
    });
    const loaded = loadToolsConfig(statePath);
    expect(loaded.tools.notion?.label).toBe("Notion");
    expect(loaded.tools.notion?.requiredParams).toEqual(["title", "content"]);
    // the effective registry merges the built-ins with the new tool
    const eff = effectiveToolSpecs(statePath);
    expect(eff.jira).toBeDefined();
    expect(eff.notion?.label).toBe("Notion");
  });

  it("corrupt / half-written config falls back to defaults and never throws", () => {
    writeFileSync(toolsPathFor(statePath), "{ not json", "utf8");
    expect(loadToolsConfig(statePath).tools).toEqual({});
    expect(effectiveToolSpecs(statePath)).toEqual(DEFAULT_TOOL_SPECS);
  });

  it("an override replaces the built-in per key (user tweaks jira)", () => {
    saveToolsConfig(statePath, {
      tools: {
        jira: { key: "jira", label: "Jira", requiredParams: ["project"] },
      },
    });
    const eff = effectiveToolSpecs(statePath);
    expect(eff.jira?.requiredParams).toEqual(["project"]); // overridden, not merged
  });
});
