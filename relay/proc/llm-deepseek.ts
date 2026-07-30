// Adapts the DeepSeek chat-completions client into the drafting LlmCaller and
// the generic JsonLlmCaller — a third LLM backend next to the Anthropic API
// (llm-anthropic) and the `claude -p` subscription path (llm-claude-cli).
//
// Why prompt-JSON instead of forced tool_choice: DeepSeek's OpenAI-compat
// function calling can't be relied on across model versions, so (exactly like
// the claude-cli adapter) we override the system prompt's tool-call tail with
// a JSON-only instruction that embeds the target schema, and parse the
// response defensively. draft.ts validates each action against the ActionItem
// schema downstream, so a stray field here is non-fatal; an unparseable blob
// yields [] (drafting) or a thrown error (generic JSON caller).

import { createDeepseekClient, type DeepseekClient } from "../io/deepseek-api.js";
import type { DraftedAction } from "./draft-prompt.js";
import type { LlmCaller } from "./draft.js";
import type { JsonLlmCaller } from "./llm-claude-cli.js";

// Find the outermost JSON object in a text blob — tolerant of markdown fences
// and leading/trailing prose. Returns null if none parses. (Same defensive
// extraction as llm-claude-cli's; duplicated rather than shared because each
// adapter owns its parsing contract.)
function extractJsonObject(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Pull the {actions:[...]} payload out of the model's content string.
// Returns [] when no JSON object is present or `actions` isn't an array —
// the draft orchestrator treats that as "nothing to draft", never a crash.
// Exported for the unit test — the parsing is the fragile part.
export function parseDeepseekActions(content: string): DraftedAction[] {
  const obj = extractJsonObject(content);
  const actions = (obj as { actions?: unknown } | null)?.actions;
  return Array.isArray(actions) ? (actions as DraftedAction[]) : [];
}

// Parse the model's content as a single JSON object for the generic JSON
// caller. Unlike the drafting path, a caller asking for an arbitrary object
// needs to KNOW the model failed (a silent null would corrupt consolidation
// / planning), so unparseable output throws.
export function parseDeepseekJsonObject(content: string): unknown {
  const obj = extractJsonObject(content);
  if (obj === null) {
    throw new Error(`deepseek: unparseable JSON in response: ${content.slice(0, 200)}`);
  }
  return obj;
}

// The original system prompt tells the model to call a tool; DeepSeek gets a
// JSON-only override instead (no reliable forced tool call). The word "json"
// must appear in the prompt for DeepSeek's json_object response_format to
// engage — these instructions guarantee it.
function jsonOutputRule(schema: Record<string, unknown>, rootKey?: string): string {
  const shape = rootKey ? ` of the form {"${rootKey}":[...]} whose "${rootKey}" array conforms` : " conforming";
  return (
    `\n\nOUTPUT MODE: Do NOT call any tool. Respond with ONLY a single JSON ` +
    `object${shape} to this JSON schema:\n${JSON.stringify(schema)}\n` +
    `No markdown fences, no prose before or after — output the JSON object and nothing else.`
  );
}

// Wrap a DeepseekClient as an LlmCaller: ask for {"actions":[...]}, parse
// defensively. Exported so tests can inject a fake client (no network).
export function deepseekLlmCaller(client: DeepseekClient): LlmCaller {
  return async (req) => {
    const content = await client.chatJson({
      system: req.system + jsonOutputRule(req.toolInputSchema, "actions"),
      userText: req.userText,
    });
    return parseDeepseekActions(content);
  };
}

// Wrap a DeepseekClient as a JsonLlmCaller for the consolidate/plan/persona
// passes, which need an arbitrary object shape, not the actions envelope.
export function deepseekJsonCaller(client: DeepseekClient): JsonLlmCaller {
  return async (req) => {
    const content = await client.chatJson({
      system: req.system + jsonOutputRule(req.toolInputSchema),
      userText: req.userText,
    });
    return parseDeepseekJsonObject(content);
  };
}

// Convenience: build ready callers from Keychain/env credentials.
// Throw DeepseekKeyMissingError if no key is configured — the entrypoints
// (run-secretary, run-notify) catch it and run scan-only.
export async function createDeepseekLlmCaller(): Promise<LlmCaller> {
  return deepseekLlmCaller(await createDeepseekClient());
}

export async function createDeepseekJsonCaller(): Promise<JsonLlmCaller> {
  return deepseekJsonCaller(await createDeepseekClient());
}
