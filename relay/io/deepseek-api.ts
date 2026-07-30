// DeepSeek chat-completions client (OpenAI-compatible API). Hand-rolled fetch,
// consistent with every other client in this repo (dependency tree stays at
// just `yaml`). Used by the DeepSeek LlmCaller/JsonLlmCaller adapters as a
// third drafting backend next to Anthropic API and the `claude` CLI.
//
// AUTH: the API key comes from (in order) opts.apiKey → env
// DEEPSEEK_API_KEY → Keychain (service taiv-secretary-deepseek). Set it once:
//   security add-generic-password -U -s taiv-secretary-deepseek \
//     -a leo@taiv.tv -w 'sk-...'
//
// STRUCTURED OUTPUT: we deliberately do NOT rely on forced tool_choice —
// DeepSeek's OpenAI-compat function-calling support has been uneven across
// model versions. Instead we request `response_format: {"type":"json_object"}`
// and embed the target JSON schema in the prompt, then parse defensively in
// the adapter (the same strategy llm-claude-cli.ts uses when it can't force a
// tool call). This module only transports text; parsing lives in
// relay/proc/llm-deepseek.ts.

import { loadIdentity } from "./identity.js";
import { getSecret } from "./keychain.js";

export const DEEPSEEK_API_BASE = "https://api.deepseek.com";
export const DEEPSEEK_KEY_SERVICE = "taiv-secretary-deepseek";
// Keychain account the DeepSeek API key is stored under. Only used by the
// `--llm deepseek` path; the default `claude` CLI path needs no key.
// Per-user, from config/identity.json.
export const DEEPSEEK_KEY_ACCOUNT = loadIdentity().primaryEmail;

// The drafting model. Default is deepseek-v4-pro (per the owner's deployment,
// 2026-07-30 — the old deepseek-chat alias is deprecated). Any newer model id
// must be adoptable WITHOUT a code change, so the env var wins (read at client
// construction, not module load).
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";

export class DeepseekApiError extends Error {
  constructor(public httpStatus: number, public body: unknown) {
    super(`DeepSeek API failed: HTTP ${httpStatus}`);
    this.name = "DeepseekApiError";
  }
}

export class DeepseekKeyMissingError extends Error {
  constructor() {
    super(
      "No DeepSeek API key. Set DEEPSEEK_API_KEY, or store it in Keychain:\n" +
        `  security add-generic-password -U -s ${DEEPSEEK_KEY_SERVICE} -a ${DEEPSEEK_KEY_ACCOUNT} -w 'sk-...'`,
    );
    this.name = "DeepseekKeyMissingError";
  }
}

interface DeepseekChatResponse {
  choices?: Array<{ message?: { role?: string; content?: string } }>;
}

export interface DeepseekClientOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  baseUrl?: string;
  model?: string;
  maxRetries?: number;
}

export async function resolveDeepseekKey(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    return await getSecret(DEEPSEEK_KEY_SERVICE, DEEPSEEK_KEY_ACCOUNT);
  } catch {
    throw new DeepseekKeyMissingError();
  }
}

export class DeepseekClient {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  readonly model: string;

  constructor(private readonly opts: DeepseekClientOptions & { apiKey: string }) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? DEEPSEEK_API_BASE;
    this.maxRetries = opts.maxRetries ?? 3;
    this.model = opts.model ?? process.env.SECRETARY_DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL;
  }

  // Single chat completion in JSON mode. Returns the assistant message content
  // (a string that SHOULD be a JSON object — parsing is the caller's job).
  // Throws DeepseekApiError on non-200 or an empty assistant message.
  async chatJson(opts: {
    system: string;
    userText: string;
    model?: string;
    maxTokens?: number;
  }): Promise<string> {
    const body = {
      model: opts.model ?? this.model,
      max_tokens: opts.maxTokens ?? 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.userText },
      ],
    };

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const resp = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = resp.headers.get("retry-after");
        const wait = retryAfter ? parseFloat(retryAfter) * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        lastErr = new Error(`DeepSeek HTTP ${resp.status}`);
        continue;
      }
      if (!resp.ok) {
        let errBody: unknown = null;
        try {
          errBody = await resp.json();
        } catch {
          errBody = await resp.text();
        }
        throw new DeepseekApiError(resp.status, errBody);
      }
      const data = (await resp.json()) as DeepseekChatResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new DeepseekApiError(200, { message: "empty assistant content" });
      }
      return content;
    }
    throw lastErr ?? new Error("DeepSeek exhausted retries");
  }
}

// Factory: resolve the key then build a client. Throws DeepseekKeyMissingError
// when no key is configured — entrypoints catch it and run scan-only.
export async function createDeepseekClient(
  opts: DeepseekClientOptions = {},
): Promise<DeepseekClient> {
  const apiKey = await resolveDeepseekKey(opts.apiKey);
  return new DeepseekClient({ ...opts, apiKey });
}
