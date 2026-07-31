import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendActivity,
  activityPathFor,
  readActivity,
  SUMMARY_MAX_CHARS,
  type ActivityRecord,
} from "./activity-log.js";

const rec = (over: Partial<ActivityRecord> = {}): ActivityRecord => ({
  at: "2026-07-31T10:00:00.000Z",
  kind: "tick",
  summary: "test event",
  ...over,
});

describe("activity-log", () => {
  it("appends one JSONL line per record, creating the dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "activity-log-"));
    try {
      const path = join(dir, "nested", "activity-log.jsonl");
      appendActivity(path, rec({ summary: "first" }));
      appendActivity(path, rec({ kind: "approve", summary: "second" }));
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).summary).toBe("first");
      expect(JSON.parse(lines[1]!).kind).toBe("approve");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates an over-long summary so appends stay PIPE_BUF-safe", () => {
    const dir = mkdtempSync(join(tmpdir(), "activity-log-"));
    try {
      const path = join(dir, "activity-log.jsonl");
      appendActivity(path, rec({ summary: "x".repeat(SUMMARY_MAX_CHARS + 500) }));
      const [r] = readActivity(readFileSync(path, "utf8"));
      expect(r!.summary).toHaveLength(SUMMARY_MAX_CHARS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readActivity skips a truncated final line instead of throwing", () => {
    const good = JSON.stringify(rec({ summary: "ok" }));
    const out = readActivity(`${good}\n{"at":"2026`);
    expect(out).toHaveLength(1);
    expect(out[0]!.summary).toBe("ok");
  });

  it("activityPathFor puts the log beside the state file", () => {
    expect(activityPathFor("/x/state/loop-state.json")).toBe("/x/state/activity-log.jsonl");
  });
});
