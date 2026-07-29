// Adapts the Anthropic client into the drafting LlmCaller. Lives apart
// from draft.ts so the orchestrator stays API-free + stub-testable; this
// is the prod adapter (mirrors wire-executor for the cockpit).

import { createAnthropicClient, type AnthropicClient } from "../io/anthropic-api.js";
import type { DraftedAction } from "./draft-prompt.js";
import type { LlmCaller } from "./draft.js";

// Wrap an AnthropicClient as an LlmCaller: force the tool call, pull the
// `actions` array out of the validated tool input. Defensive parsing —
// the orchestrator validates each action against the ActionItem schema
// downstream, so here we only guarantee we return an array.
function anthropicLlmCaller(client: AnthropicClient): LlmCaller {
  return async (req) => {
    const input = await client.toolCall({
      system: req.system,
      userText: req.userText,
      toolName: req.toolName,
      toolInputSchema: req.toolInputSchema,
    });
    const actions = (input as { actions?: unknown })?.actions;
    if (!Array.isArray(actions)) return [];
    return actions as DraftedAction[];
  };
}

// Convenience: build a ready LlmCaller from Keychain/env credentials.
// Throws AnthropicKeyMissingError if no key is configured — the caller
// (run-secretary) catches it and runs scan-only.
export async function createAnthropicLlmCaller(): Promise<LlmCaller> {
  const client = await createAnthropicClient();
  return anthropicLlmCaller(client);
}

// Generic structured-JSON caller (parity with createClaudeCliJsonCaller) — the
// task-consolidation pass needs an arbitrary object back, not DraftedAction[].
// Forces a tool call and returns its validated input verbatim.
export async function createAnthropicJsonCaller(): Promise<
  (req: { system: string; userText: string; toolInputSchema: Record<string, unknown> }) => Promise<unknown>
> {
  const client = await createAnthropicClient();
  return (req) =>
    client.toolCall({
      system: req.system,
      userText: req.userText,
      toolName: "emit_task_groups",
      toolInputSchema: req.toolInputSchema,
    });
}
