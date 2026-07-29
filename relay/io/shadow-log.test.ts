import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendShadowRecord,
  readShadowLog,
  summarizeShadowLog,
} from "./shadow-log.js";
import { buildShadowRecord } from "../core/shadow.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-shadow-"));
  logPath = join(dir, "shadow-log.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("appendShadowRecord + readShadowLog", () => {
  it("roundtrips a single record", () => {
    const rec = buildShadowRecord("2026-06-13T10:00:00Z", [], {});
    appendShadowRecord(logPath, rec);
    const { records, parseErrors } = readShadowLog(logPath);
    expect(parseErrors).toEqual([]);
    expect(records).toEqual([rec]);
  });

  it("appends — never overwrites — across multiple writes", () => {
    const r1 = buildShadowRecord("2026-06-13T10:00:00Z", [], { runtime: "a" });
    const r2 = buildShadowRecord("2026-06-13T10:01:00Z", [], { runtime: "b" });
    appendShadowRecord(logPath, r1);
    appendShadowRecord(logPath, r2);
    const { records } = readShadowLog(logPath);
    expect(records.map((r) => r.runtime)).toEqual(["a", "b"]);
  });

  it("creates the parent directory if missing (round-commit's first write shouldn't fail)", () => {
    const nested = join(dir, "deep", "nested", "shadow-log.jsonl");
    const rec = buildShadowRecord("t", [], {});
    expect(() => appendShadowRecord(nested, rec)).not.toThrow();
    expect(readShadowLog(nested).records).toHaveLength(1);
  });

  it("missing file returns empty result (shadow logging is opt-in per round)", () => {
    const missing = join(dir, "never-written.jsonl");
    expect(readShadowLog(missing)).toEqual({ records: [], parseErrors: [] });
  });

  it("malformed lines are surfaced with 1-based line numbers, never silently dropped", () => {
    const r1 = buildShadowRecord("2026-06-13T10:00:00Z", [], {});
    writeFileSync(
      logPath,
      JSON.stringify(r1) + "\n" + "{this is not json}\n" + JSON.stringify(r1) + "\n",
      "utf8",
    );
    const { records, parseErrors } = readShadowLog(logPath);
    expect(records).toHaveLength(2);
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]!.lineNo).toBe(2);
  });

  it("ignores blank lines (trailing newline is normal)", () => {
    const r = buildShadowRecord("t", [], {});
    writeFileSync(logPath, JSON.stringify(r) + "\n\n\n", "utf8");
    expect(readShadowLog(logPath).records).toHaveLength(1);
  });

  it("written lines are valid jsonl — one record per line, no embedded newlines", () => {
    const rec = buildShadowRecord("2026-06-13T10:00:00Z", [], {});
    appendShadowRecord(logPath, rec);
    const raw = readFileSync(logPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(rec);
  });
});

describe("summarizeShadowLog", () => {
  it("counts records, source messages, filtered, actions; surfaces time range", () => {
    const r1 = buildShadowRecord("2026-06-13T10:00:00Z", [], {
      source_messages: [
        {
          id: "m1",
          platform: "slack",
          senderHandle: "U1",
          timestampMs: 1,
          text: "hi",
          source: "slack:C1",
          isDirectMessage: true,
          mentionsUser: false,
          isReplyInUserThread: false,
          recipientsIncludeUser: false,
          threadAnsweredByUserAfter: false,
        },
      ],
      filtered: [{ id: "m1", reason: "bot-or-noreply" }],
    });
    const r2 = buildShadowRecord("2026-06-13T10:30:00Z", [], {});
    appendShadowRecord(logPath, r1);
    appendShadowRecord(logPath, r2);
    const s = summarizeShadowLog(logPath);
    expect(s.records).toBe(2);
    expect(s.sourceMessages).toBe(1);
    expect(s.filtered).toBe(1);
    expect(s.actions).toBe(0);
    expect(s.firstRoundAt).toBe("2026-06-13T10:00:00Z");
    expect(s.lastRoundAt).toBe("2026-06-13T10:30:00Z");
  });

  it("empty (missing) log → all-zero summary", () => {
    expect(summarizeShadowLog(logPath)).toEqual({
      records: 0,
      parseErrors: 0,
      firstRoundAt: null,
      lastRoundAt: null,
      sourceMessages: 0,
      filtered: 0,
      actions: 0,
    });
  });
});
