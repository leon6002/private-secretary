import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listStaged,
  personaPath,
  promoteStaged,
  readPersonaV3File,
  retireMergedSecondary,
  stagedPath,
  writePersonaFile,
} from "./persona-store.js";
import type { PersonaV3 } from "../core/persona-v3.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "persona-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sample: PersonaV3 = {
  key: "test-contact",
  display_name: "Test Contact",
  identity: { role: "Engineer", relationship: "peer" },
  handles: { slack: "U123", gmail: "t@x.com", wechat: null },
  communication: { language: "en", register: "casual", tone_notes: "manual notes" },
  open_threads: "thread A still open",
  provenance: {
    "identity.*": "manual",
    "communication.*": "manual",
    open_threads: "manual",
  },
  style_profile_meta: { last_built_at: null },
};

function createLive(p: PersonaV3 = sample): string {
  const file = personaPath(dir, p.key);
  writePersonaFile(file, { full: p }, "human");
  return file;
}

describe("writePersonaFile", () => {
  it("creates canonical YAML for a new persona (human)", () => {
    const file = createLive();
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("key: test-contact")).toBe(true);
    expect(text.indexOf("identity:")).toBeLessThan(text.indexOf("communication:"));
    expect(text).not.toContain("commitments"); // empty blocks omitted
    expect(readPersonaV3File(file).open_threads).toBe("thread A still open");
  });

  it("round-trip: a no-op edit cycle leaves the file byte-identical", () => {
    const file = createLive();
    const before = readFileSync(file, "utf8");
    // llm write where everything is blocked -> nothing applied, no rewrite
    const res = writePersonaFile(
      file,
      { set: { open_threads: "x" }, evidence: { open_threads: "e" } },
      "llm",
    );
    expect(res.blockedByR1).toEqual(["open_threads"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("R1 at the chokepoint: llm cannot touch manual fields, allowed fields land with provenance+evidence", () => {
    const file = createLive();
    const res = writePersonaFile(
      file,
      {
        set: {
          "communication.tone_notes": "rewritten", // manual -> blocked
          "behavior.reliability": "responds fast", // free -> applied
        },
        evidence: {
          "communication.tone_notes": "msg",
          "behavior.reliability": "slack:D1:1781.0",
        },
      },
      "llm",
    );
    expect(res.blockedByR1).toEqual(["communication.tone_notes"]);
    expect(res.applied).toEqual(["behavior.reliability"]);
    const after = readPersonaV3File(file);
    expect(after.communication?.tone_notes).toBe("manual notes");
    expect(after.behavior?.reliability).toBe("responds fast");
    expect(after.provenance?.["behavior.reliability"]).toBe("inferred");
    expect(after.evidence?.["behavior.reliability"]).toBe("slack:D1:1781.0");
  });

  it("llm cannot whole-file overwrite an existing persona", () => {
    const file = createLive();
    expect(() => writePersonaFile(file, { full: sample }, "llm")).toThrow(/overwrite/);
  });

  it("llm full write of a NEW file demands strict provenance+evidence coverage", () => {
    const bad: PersonaV3 = {
      key: "newbie",
      display_name: "New Person",
      behavior: { reliability: "high" }, // no provenance entry
    };
    expect(() =>
      writePersonaFile(stagedPath(dir, "newbie"), { full: bad }, "llm"),
    ).toThrow(/no provenance entry/);

    const good: PersonaV3 = {
      ...bad,
      provenance: { "behavior.*": "inferred", "handles.*": "inferred" },
      evidence: { "behavior.*": "slack:D2:99.0", "handles.*": "profile" },
      handles: { slack: "U9" },
    };
    const res = writePersonaFile(stagedPath(dir, "newbie"), { full: good }, "llm");
    expect(res.mode).toBe("created");
    expect(listStaged(dir)).toEqual(["newbie"]);
  });

  it("llm full write may NOT carry corrections (human-only, §7B)", () => {
    const withCorr: PersonaV3 = {
      key: "newbie",
      display_name: "New Person",
      corrections: [{ scene: "x", wrong: "y", correct: "z" }],
      provenance: { corrections: "manual" },
    };
    expect(() =>
      writePersonaFile(stagedPath(dir, "newbie"), { full: withCorr }, "llm"),
    ).toThrow(/may not write corrections/);
  });
});

describe("promoteStaged", () => {
  it("moves a staged persona live when none exists", () => {
    const staged: PersonaV3 = {
      key: "fresh",
      display_name: "Fresh",
      communication: { language: "en", register: "casual" },
      provenance: { "communication.*": "inferred" },
      evidence: { "communication.*": "msgs" },
    };
    writePersonaFile(stagedPath(dir, "fresh"), { full: staged }, "llm");
    const res = promoteStaged(dir, "fresh");
    expect(res.action).toBe("moved");
    expect(existsSync(personaPath(dir, "fresh"))).toBe(true);
    expect(listStaged(dir)).toEqual([]);
  });

  it("replaces a v2 live file wholesale (migration path)", () => {
    const v2 = `key: legacy\ndisplay_name: Legacy\nlanguage: en\nregister: casual\n`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(personaPath(dir, "legacy"), v2, "utf8");
    writePersonaFile(
      stagedPath(dir, "legacy"),
      {
        full: {
          key: "legacy",
          display_name: "Legacy",
          communication: { language: "en", register: "casual" },
          provenance: { "communication.*": "manual" },
        },
      },
      "human",
    );
    const res = promoteStaged(dir, "legacy");
    expect(res.action).toBe("replaced-v2");
    expect(readPersonaV3File(personaPath(dir, "legacy")).communication?.language).toBe("en");
  });

  it("merging into a v3 live file keeps live manual fields (R1 on promote)", () => {
    createLive();
    const rebuilt: PersonaV3 = {
      key: "test-contact",
      display_name: "Test Contact",
      identity: { role: "REBUILT" },
      behavior: { reliability: "high" },
      provenance: { "identity.*": "inferred", "behavior.*": "inferred" },
      evidence: { "identity.*": "msgs", "behavior.*": "msgs" },
    };
    writePersonaFile(stagedPath(dir, "test-contact"), { full: rebuilt }, "llm");
    const res = promoteStaged(dir, "test-contact");
    expect(res.action).toBe("merged");
    expect(res.keptManual).toContain("identity.role");
    const after = readPersonaV3File(personaPath(dir, "test-contact"));
    expect(after.identity?.role).toBe("Engineer"); // manual survived
    expect(after.behavior?.reliability).toBe("high"); // new inference landed
  });

  it("throws when nothing is staged", () => {
    expect(() => promoteStaged(dir, "ghost")).toThrow(/no staged persona/);
  });

  // Task 1 requirement: a manual `aliases` must survive a rebuild. A re-bootstrap
  // stages a fresh persona WITHOUT aliases; promote (the rebuild) must keep the
  // live manual alias — both because FIELD_ORDER carries it through canonicalize
  // and because R1 protects the manual field on merge.
  it("manual aliases survives a re-promote (rebuild)", () => {
    createLive({
      key: "test-contact",
      display_name: "Michael Patrick Zaragoza",
      aliases: ["Patrick"],
      communication: { language: "en", register: "casual" },
      provenance: { aliases: "manual", "communication.*": "manual" },
    });
    const rebuilt: PersonaV3 = {
      key: "test-contact",
      display_name: "Michael Patrick Zaragoza",
      behavior: { reliability: "high" },
      provenance: { "behavior.*": "inferred" },
      evidence: { "behavior.*": "msgs" },
    };
    writePersonaFile(stagedPath(dir, "test-contact"), { full: rebuilt }, "llm");
    promoteStaged(dir, "test-contact");
    const after = readPersonaV3File(personaPath(dir, "test-contact"));
    expect(after.aliases).toEqual(["Patrick"]);
  });
});

describe("retireMergedSecondary", () => {
  it("moves the secondary to a backup dir instead of deleting", () => {
    createLive();
    const backup = retireMergedSecondary(dir, "test-contact");
    expect(existsSync(personaPath(dir, "test-contact"))).toBe(false);
    expect(existsSync(backup)).toBe(true);
  });
});
