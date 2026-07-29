import { describe, it, expect } from "vitest";
import { AnthropicApiError, AnthropicClient } from "./anthropic-api.js";

function fakeFetch(
  responder: (url: string, init: RequestInit) => {
    ok: boolean;
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  },
): { fetchFn: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = responder(url, init ?? {});
    const headers = new Map(Object.entries(r.headers ?? {}));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? headers.get(k) ?? null } as Headers,
      json: async () => r.body,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    } as Response;
  };
  return { fetchFn, calls };
}

const toolReq = {
  system: "you are a test",
  userText: "do the thing",
  toolName: "emit_action_items",
  toolInputSchema: { type: "object", properties: { actions: { type: "array" } }, required: ["actions"] },
};

describe("AnthropicClient.toolCall", () => {
  it("forces the tool and returns the tool_use input", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu_1", name: "emit_action_items", input: { actions: [{ action_type: "task" }] } },
        ],
      },
    }));
    const c = new AnthropicClient({ apiKey: "sk-ant-test", fetchFn });
    const out = await c.toolCall(toolReq);
    expect(out).toEqual({ actions: [{ action_type: "task" }] });
    // request shape: forced tool_choice, x-api-key + version headers, system + user
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_action_items" });
    expect(body.system).toBe("you are a test");
    expect((body.messages as unknown[])[0]).toEqual({ role: "user", content: "do the thing" });
  });

  it("sends x-api-key + anthropic-version headers", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchFn: typeof fetch = async (_u, init) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return {
        ok: true,
        status: 200,
        headers: { get: () => null } as unknown as Headers,
        json: async () => ({
          content: [{ type: "tool_use", name: "emit_action_items", input: { actions: [] } }],
          stop_reason: "tool_use",
        }),
      } as Response;
    };
    const c = new AnthropicClient({ apiKey: "sk-ant-xyz", fetchFn });
    await c.toolCall(toolReq);
    expect(seenHeaders["x-api-key"]).toBe("sk-ant-xyz");
    expect(seenHeaders["anthropic-version"]).toBeTruthy();
  });

  it("throws when the model fails to call the tool", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: true,
      body: {
        content: [{ type: "text", text: "I refuse" }],
        stop_reason: "end_turn",
      },
    }));
    const c = new AnthropicClient({ apiKey: "k", fetchFn, maxRetries: 0 });
    await expect(c.toolCall(toolReq)).rejects.toBeInstanceOf(AnthropicApiError);
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1) return { ok: false, status: 429, headers: { "retry-after": "0" }, body: {} };
      return {
        ok: true,
        body: { content: [{ type: "tool_use", name: "emit_action_items", input: { actions: [] } }], stop_reason: "tool_use" },
      };
    });
    const c = new AnthropicClient({ apiKey: "k", fetchFn, maxRetries: 2 });
    await c.toolCall(toolReq);
    expect(n).toBe(2);
  });

  it("throws AnthropicApiError on 4xx", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: false,
      status: 400,
      body: { error: { type: "invalid_request_error", message: "bad" } },
    }));
    const c = new AnthropicClient({ apiKey: "k", fetchFn, maxRetries: 0 });
    await expect(c.toolCall(toolReq)).rejects.toBeInstanceOf(AnthropicApiError);
  });

  it("uses the configured model", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { content: [{ type: "tool_use", name: "emit_action_items", input: { actions: [] } }], stop_reason: "tool_use" },
    }));
    const c = new AnthropicClient({ apiKey: "k", fetchFn, model: "claude-test-model" });
    await c.toolCall(toolReq);
    expect((calls[0]!.body as Record<string, unknown>).model).toBe("claude-test-model");
  });
});
