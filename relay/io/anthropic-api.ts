// Anthropic Messages API client. Hand-rolled fetch (consistent with the
// Slack/Gmail/Calendar/MCP clients — this repo keeps its dependency tree
// to just `yaml`). Used by the LLM drafting step to turn candidate
// messages into structured action items via a forced tool call.
//
// AUTH: the API key comes from (in order) opts.apiKey → env
// ANTHROPIC_API_KEY → Keychain (service taiv-secretary-anthropic). Set it
// once with:
//   security add-generic-password -U -s taiv-secretary-anthropic \
//     -a leo@taiv.tv -w 'sk-ant-...'
//
// STRUCTURED OUTPUT: we force a single tool call (tool_choice) so the model
// returns a typed object instead of free text we'd have to parse. The
// drafting LlmCaller pulls the tool_use input out of the response.

import { loadIdentity } from "./identity.js";
import { getSecret } from "./keychain.js";

export const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_KEY_SERVICE = "taiv-secretary-anthropic";
// Keychain account the (optional) Anthropic API key is stored under. Only used
// by the `--llm api` path; the default subscription path shells out to `claude`
// and needs no key. Per-user, from config/identity.json.
export const ANTHROPIC_KEY_ACCOUNT = loadIdentity().primaryEmail;

// The drafting model. Opus-class for judgment quality on the wrong-recipient-
// sensitive analysis; the daemon only calls it on filtered candidates so
// volume is low. Override via env if needed.
export const DEFAULT_DRAFT_MODEL =
  process.env.ANTHROPIC_DRAFT_MODEL ?? "claude-opus-4-8";

export class AnthropicApiError extends Error {
  constructor(public httpStatus: number, public body: unknown) {
    super(`Anthropic API failed: HTTP ${httpStatus}`);
    this.name = "AnthropicApiError";
  }
}

export class AnthropicKeyMissingError extends Error {
  constructor() {
    super(
      "No Anthropic API key. Set ANTHROPIC_API_KEY, or store it in Keychain:\n" +
        `  security add-generic-password -U -s ${ANTHROPIC_KEY_SERVICE} -a ${ANTHROPIC_KEY_ACCOUNT} -w 'sk-ant-...'`,
    );
    this.name = "AnthropicKeyMissingError";
  }
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicContentBlock {
  type: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
  // text blocks
  text?: string;
}

interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface AnthropicClientOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  model?: string;
  maxRetries?: number;
}

export async function resolveAnthropicKey(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return await getSecret(ANTHROPIC_KEY_SERVICE, ANTHROPIC_KEY_ACCOUNT);
  } catch {
    throw new AnthropicKeyMissingError();
  }
}

export class AnthropicClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  readonly model: string;

  constructor(private readonly opts: AnthropicClientOptions & { apiKey: string }) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? ANTHROPIC_API_BASE;
    this.maxRetries = opts.maxRetries ?? 3;
    this.model = opts.model ?? DEFAULT_DRAFT_MODEL;
  }

  // Single forced-tool-call completion. Returns the tool input object the
  // model produced. Throws if the model didn't call the tool.
  async toolCall(opts: {
    system: string;
    userText: string;
    toolName: string;
    toolInputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<unknown> {
    const tool: AnthropicTool = {
      name: opts.toolName,
      description: "Emit the structured result.",
      input_schema: opts.toolInputSchema,
    };
    const body = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      tools: [tool],
      tool_choice: { type: "tool", name: opts.toolName },
      messages: [{ role: "user", content: opts.userText }],
    };

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const resp = await this.fetchFn(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = resp.headers.get("retry-after");
        const wait = retryAfter ? parseFloat(retryAfter) * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        lastErr = new Error(`Anthropic HTTP ${resp.status}`);
        continue;
      }
      if (!resp.ok) {
        let errBody: unknown = null;
        try {
          errBody = await resp.json();
        } catch {
          errBody = await resp.text();
        }
        throw new AnthropicApiError(resp.status, errBody);
      }
      const data = (await resp.json()) as AnthropicMessageResponse;
      const toolUse = data.content.find(
        (b) => b.type === "tool_use" && b.name === opts.toolName,
      );
      if (!toolUse) {
        throw new AnthropicApiError(200, {
          message: `model did not call ${opts.toolName}`,
          stop_reason: data.stop_reason,
        });
      }
      return toolUse.input;
    }
    throw lastErr ?? new Error("Anthropic exhausted retries");
  }
}

// Factory: resolve the key then build a client.
export async function createAnthropicClient(
  opts: AnthropicClientOptions = {},
): Promise<AnthropicClient> {
  const apiKey = await resolveAnthropicKey(opts.apiKey);
  return new AnthropicClient({ ...opts, apiKey });
}
