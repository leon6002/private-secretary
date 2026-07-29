// Persona file store — THE single write chokepoint for personas/*.yaml.
// R1 ("manual always wins") is enforced HERE for every actor="llm" write by
// routing through applyLlmUpdates(); no caller re-implements the guard.
// Reads/edits use the yaml Document API so existing field order and comments
// survive round-trip; brand-new files are emitted in canonical FIELD_ORDER.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import {
  applyLlmUpdates,
  isV3,
  mergeStagedIntoLive,
  validatePersonaV3,
  FIELD_ORDER,
  type LlmUpdate,
  type PersonaV3,
  type ProvenanceTag,
} from "../core/persona-v3.js";

export const STAGED_DIRNAME = "_staged";
export const MERGED_BACKUP_DIRNAME = "_merged-backup";

export type WriteActor = "llm" | "human";

export interface PersonaWriteRequest extends Partial<LlmUpdate> {
  full?: PersonaV3; // whole-file write: new files (any actor) or human overwrite
  provenance?: Record<string, ProvenanceTag>; // human-only explicit tags
}

export interface PersonaWriteResult {
  file: string;
  mode: "created" | "updated" | "overwritten";
  applied: string[];
  blockedByR1: string[];
  missingEvidence: string[];
  invalid: string[];
}

export function personaPath(personaDir: string, key: string): string {
  return join(personaDir, `${key}.yaml`);
}

export function stagedPath(personaDir: string, key: string): string {
  return join(personaDir, STAGED_DIRNAME, `${key}.yaml`);
}

export function readPersonaV3File(file: string): PersonaV3 {
  return parse(readFileSync(file, "utf8")) as PersonaV3;
}

// Rebuild in canonical order, dropping empty blocks (spec: 空块直接省略).
// handles keeps explicit nulls — they are real "no handle on this platform"
// placeholders, the one sanctioned null in the schema.
export function canonicalize(p: PersonaV3): PersonaV3 {
  const out: Record<string, unknown> = {};
  for (const field of FIELD_ORDER) {
    const v = p[field];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[field] = v;
  }
  return out as unknown as PersonaV3;
}

function emit(p: PersonaV3): string {
  return stringify(canonicalize(p), { lineWidth: 100 });
}

function writeFileEnsuringDir(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

const ok = (
  file: string,
  mode: PersonaWriteResult["mode"],
  applied: string[] = [],
): PersonaWriteResult => ({
  file,
  mode,
  applied,
  blockedByR1: [],
  missingEvidence: [],
  invalid: [],
});

export function writePersonaFile(
  file: string,
  request: PersonaWriteRequest,
  actor: WriteActor,
): PersonaWriteResult {
  const exists = existsSync(file);

  if (request.full) {
    if (exists && actor === "llm")
      throw new Error(
        "llm may not whole-file overwrite an existing persona — use {set, evidence} " +
          "field updates (R1 guard), or stage + promote",
      );
    if (actor === "llm" && (request.full.corrections?.length ?? 0) > 0)
      throw new Error(
        "llm may not write corrections — they are human-stated feedback (use persona-correct)",
      );
    // New-file strictness scales with trust: LLM-built personas must cover
    // every field with provenance and every inferred field with evidence.
    const errors = validatePersonaV3(request.full, { strictCoverage: actor === "llm" });
    if (errors.length) throw new Error(`invalid persona: ${errors.join("; ")}`);
    writeFileEnsuringDir(file, emit(request.full));
    return ok(file, exists ? "overwritten" : "created");
  }

  if (!exists) throw new Error(`persona file not found: ${file} (use {full} to create)`);
  if (!request.set || Object.keys(request.set).length === 0)
    throw new Error("nothing to write: provide {set} or {full}");

  const doc = parseDocument(readFileSync(file, "utf8"));
  const current = doc.toJS() as PersonaV3;

  if (actor === "llm") {
    const res = applyLlmUpdates(current, {
      set: request.set,
      evidence: request.evidence ?? {},
    });
    for (const path of res.applied) {
      const value = res.persona ? getByPath(res.persona, path) : undefined;
      if (value === undefined) doc.deleteIn(path.split("."));
      else doc.setIn(path.split("."), value);
      doc.setIn(["provenance", path], "inferred");
      doc.setIn(["evidence", path], request.evidence?.[path]);
    }
    if (res.applied.length > 0) writeFileEnsuringDir(file, doc.toString());
    return {
      file,
      mode: "updated",
      applied: res.applied,
      blockedByR1: res.blockedByR1,
      missingEvidence: res.missingEvidence,
      invalid: res.invalid,
    };
  }

  // human: unrestricted — sets values, may pin provenance tags explicitly
  const applied: string[] = [];
  for (const [path, value] of Object.entries(request.set)) {
    if (value === null || value === undefined) doc.deleteIn(path.split("."));
    else doc.setIn(path.split("."), value);
    applied.push(path);
  }
  for (const [path, tag] of Object.entries(request.provenance ?? {}))
    doc.setIn(["provenance", path], tag);
  for (const [path, ev] of Object.entries(request.evidence ?? {}))
    doc.setIn(["evidence", path], ev);
  writeFileEnsuringDir(file, doc.toString());
  return ok(file, "updated", applied);
}

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export interface PromoteResult {
  key: string;
  action: "moved" | "replaced-v2" | "merged";
  keptManual: string[];
}

// Staging -> live. Live v2 file (pre-migration shape) is replaced wholesale;
// live v3 merges with live-manual-fields-win (R1).
export function promoteStaged(personaDir: string, key: string): PromoteResult {
  const staged = stagedPath(personaDir, key);
  const live = personaPath(personaDir, key);
  if (!existsSync(staged)) throw new Error(`no staged persona for ${key}`);

  if (!existsSync(live)) {
    mkdirSync(dirname(live), { recursive: true });
    renameSync(staged, live);
    return { key, action: "moved", keptManual: [] };
  }

  const liveRaw = parse(readFileSync(live, "utf8")) as Record<string, unknown>;
  if (!isV3(liveRaw)) {
    writeFileSync(live, readFileSync(staged, "utf8"), "utf8");
    rmSync(staged);
    return { key, action: "replaced-v2", keptManual: [] };
  }

  const stagedPersona = readPersonaV3File(staged);
  const { merged, keptManual } = mergeStagedIntoLive(
    liveRaw as unknown as PersonaV3,
    stagedPersona,
  );
  writeFileSync(live, emit(merged), "utf8");
  rmSync(staged);
  return { key, action: "merged", keptManual };
}

export function listStaged(personaDir: string): string[] {
  const dir = join(personaDir, STAGED_DIRNAME);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(/\.yaml$/, ""));
  } catch {
    return [];
  }
}

// R3 merge on user approval: write the merged primary, move the secondary's
// file to a backup dir (never hard-delete a persona).
export function retireMergedSecondary(personaDir: string, key: string): string {
  const from = personaPath(personaDir, key);
  const backupDir = join(personaDir, MERGED_BACKUP_DIRNAME);
  mkdirSync(backupDir, { recursive: true });
  const to = join(backupDir, `${key}.yaml`);
  renameSync(from, to);
  return to;
}
