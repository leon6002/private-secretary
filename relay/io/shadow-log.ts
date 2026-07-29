// Shadow-mode log writer/reader (Phase 3, B). Append-only NDJSON: one
// ShadowRecord per line. Format is intentionally boring — `jq` reads it, a
// future replay harness reads it, future runtimes can write to it too.
//
// Concurrency: single-process v1 has one writer. POSIX appendFileSync is
// atomic per write call for lines under PIPE_BUF (~4KB on macOS, 64KB on
// Linux). A typical record is well under that. If a multi-writer case ever
// appears, switch to write-temp + rename or a lockfile — DO NOT just hope.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ShadowRecord } from "../core/shadow.js";

export function appendShadowRecord(filePath: string, rec: ShadowRecord): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(filePath, JSON.stringify(rec) + "\n", { encoding: "utf8" });
}

export interface ParseError {
  lineNo: number; // 1-based
  error: string;
}

export interface ShadowLogReadResult {
  records: ShadowRecord[];
  parseErrors: ParseError[];
}

// Read every record. Lines that fail to parse are surfaced (with their 1-based
// line number) — never dropped silently. Missing file returns empty, not an
// error: shadow logging is opt-in per scan, not required.
export function readShadowLog(filePath: string): ShadowLogReadResult {
  if (!existsSync(filePath)) return { records: [], parseErrors: [] };
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  const records: ShadowRecord[] = [];
  const parseErrors: ParseError[] = [];
  lines.forEach((line, idx) => {
    if (line.length === 0) return; // trailing newline / blank line
    try {
      records.push(JSON.parse(line) as ShadowRecord);
    } catch (e) {
      parseErrors.push({ lineNo: idx + 1, error: String(e) });
    }
  });
  return { records, parseErrors };
}

// Convenience for the CLI summary: how many records, time range, totals.
export interface ShadowLogSummary {
  records: number;
  parseErrors: number;
  firstRoundAt: string | null;
  lastRoundAt: string | null;
  sourceMessages: number;
  filtered: number;
  actions: number;
}

export function summarizeShadowLog(filePath: string): ShadowLogSummary {
  const { records, parseErrors } = readShadowLog(filePath);
  let sourceMessages = 0;
  let filtered = 0;
  let actions = 0;
  for (const r of records) {
    sourceMessages += r.source_messages.length;
    filtered += r.filtered.length;
    actions += r.actions.length;
  }
  return {
    records: records.length,
    parseErrors: parseErrors.length,
    firstRoundAt: records[0]?.round_at ?? null,
    lastRoundAt: records[records.length - 1]?.round_at ?? null,
    sourceMessages,
    filtered,
    actions,
  };
}
