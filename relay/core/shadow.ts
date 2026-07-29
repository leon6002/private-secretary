// Shadow-mode validation dataset (Phase 3, B). Every round-commit appends one
// IMMUTABLE record of what the runtime saw (source messages) and what it
// produced (actions at commit time, filter rejections). The new runtime
// (T-conn / direct API) replays this dataset to verify parity — same input,
// same decisions — before live auto-detection turns on (specs/phase3-local-mac
// §4 #16).
//
// What this records (and what it doesn't):
//   ✓ The raw InboundMessage shape (post-normalize). The only place the
//     structured message lives — action.context.original_message is a snippet.
//   ✓ Pre-analysis filter rejections (not-addressed / bot / already-handled).
//   ✓ Action items AT COMMIT TIME. status is "suggested" unless an auto-execute
//     rule fired; never reflects later approval/edit decisions (those live
//     in loop-state.actions + outcomes — separate, mutable surfaces).
//   ✗ User decisions. The gate (computed elsewhere) joins shadow records with
//     outcomes by action id.

import type { ActionItem } from "./action-item.js";
import type { InboundMessage } from "./types.js";

export const SHADOW_SCHEMA_VERSION = 1 as const;

// Reason matches FilterDecision in trigger-filter.ts — kept as string here so
// shadow records don't tie the schema to the filter's enum. Future filter
// reasons can be added without a schema bump.
export interface ShadowFilterRejection {
  id: string; // source message id (matches InboundMessage.id)
  reason: string;
  // P0: the message TEXT of what we filtered out. Without it, trigger-filter
  // recall is unmeasurable — you can see that something was dropped but never
  // whether dropping it was right. Recall cannot be derived from the approve/
  // skip log either (that only covers what the system chose to surface), so this
  // is the only path to a recall number. Optional for back-compat with the
  // 1,111 rounds already on disk, which have no text.
  text?: string;
  sender?: string;
  platform?: string;
}

export interface ShadowRecord {
  schema_version: typeof SHADOW_SCHEMA_VERSION;
  round_at: string; // ISO timestamp of the commit
  runtime: string; // identifier of the runtime that produced this record
  source_messages: InboundMessage[]; // every InboundMessage the round consumed
  filtered: ShadowFilterRejection[]; // pre-analysis rejections
  actions: ActionItem[]; // action snapshots at commit time
}

export interface ShadowRecordInput {
  source_messages?: InboundMessage[];
  filtered?: ShadowFilterRejection[];
  runtime?: string;
}

export const DEFAULT_RUNTIME = "claude-code-mvp";

// Build an immutable record from the round-commit payload. Absent fields
// default to empty arrays — a partial caller never crashes the writer.
export function buildShadowRecord(
  roundAt: string,
  actions: ActionItem[],
  input: ShadowRecordInput,
): ShadowRecord {
  return {
    schema_version: SHADOW_SCHEMA_VERSION,
    round_at: roundAt,
    runtime: input.runtime ?? DEFAULT_RUNTIME,
    source_messages: input.source_messages ?? [],
    filtered: input.filtered ?? [],
    actions,
  };
}

// True if the input would produce a record worth writing. A scan that read
// nothing and committed nothing has nothing to validate — skip the append so
// the log stays signal-only.
export function shouldWriteShadowRecord(
  actions: ActionItem[],
  input: ShadowRecordInput,
): boolean {
  return (
    actions.length > 0 ||
    (input.source_messages?.length ?? 0) > 0 ||
    (input.filtered?.length ?? 0) > 0
  );
}
