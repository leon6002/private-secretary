// Raw LLM draft-response capture (observability). DeepSeek drafting is
// flaky: the same triggered message can draft 0 cards on one run and 2 on a
// re-run, and because the cursor has already advanced that silent empty is a
// PERMANENT skip. This log is the feedback loop: every draft call that comes
// back with no usable actions appends the raw model response here (NDJSON,
// one record per line) so prompt tuning works from evidence, not guesses.
//
// Append-only, same pattern + concurrency assumptions as shadow-log.ts
// (single writer per process, POSIX append atomicity under PIPE_BUF; a
// truncated 4KB record stays well under that).

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface RawLlmRecord {
  at: string; // ISO timestamp of the draft call
  // empty-actions = the response parsed but carried no actions array (or an
  // empty one) — the model decided "nothing to do", or answered off-schema.
  // parse-failure = no JSON object could be extracted at all.
  kind: "empty-actions" | "parse-failure";
  model: string;
  raw: string; // the model's content string, truncated to RAW_MAX_CHARS
}

// Raw responses can be long; 4KB keeps the full "what did the model actually
// say" for any realistic draft answer while keeping the log greppable.
export const RAW_MAX_CHARS = 4000;

export function appendRawLlmRecord(filePath: string, rec: RawLlmRecord): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const truncated =
    rec.raw.length > RAW_MAX_CHARS ? rec.raw.slice(0, RAW_MAX_CHARS) : rec.raw;
  appendFileSync(filePath, JSON.stringify({ ...rec, raw: truncated }) + "\n", {
    encoding: "utf8",
  });
}
