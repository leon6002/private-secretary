import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRawLlmRecord,
  RAW_MAX_CHARS,
  type RawLlmRecord,
} from "./llm-raw-log.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-raw-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<RawLlmRecord> = {}): RawLlmRecord => ({
  at: "2026-07-30T12:00:00.000Z",
  kind: "empty-actions",
  model: "deepseek-v4-pro",
  raw: '{"actions":[]}',
  ...over,
});

describe("appendRawLlmRecord", () => {
  it("appends one JSON line per record, creating the parent dir", () => {
    const p = join(dir, "nested", "raw.jsonl");
    appendRawLlmRecord(p, rec());
    appendRawLlmRecord(p, rec({ kind: "parse-failure", raw: "not json at all" }));
    const lines = readFileSync(p, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(rec());
    expect(JSON.parse(lines[1]!).kind).toBe("parse-failure");
  });

  it("truncates raw to RAW_MAX_CHARS", () => {
    const p = join(dir, "raw.jsonl");
    appendRawLlmRecord(p, rec({ raw: "x".repeat(RAW_MAX_CHARS + 500) }));
    const line = readFileSync(p, "utf8").trim();
    expect(JSON.parse(line).raw).toHaveLength(RAW_MAX_CHARS);
  });
});
