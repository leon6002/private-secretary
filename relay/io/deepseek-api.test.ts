import { describe, it, expect, afterEach } from "vitest";
import {
  DeepseekApiError,
  DeepseekClient,
  DeepseekKeyMissingError,
  resolveDeepseekKey,
} from "./deepseek-api.js";
import { __setRunner } from "./keychain.js";

// The env var + the module-scope Keychain runner are the two ambient inputs to
// key resolution; snapshot/restore both so tests stay hermetic.
const savedEnvKey = process.env.DEEPSEEK_API_KEY;
const savedEnvModel = process.env.SECRETARY_DEEPSEEK_MODEL;
afterEach(() => {
  if (savedEnvKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = savedEnvKey;
  if (savedEnvModel === undefined) delete process.env.SECRETARY_DEEPSEEK_MODEL;
  else process.env.SECRETARY_DEEPSEEK_MODEL = savedEnvModel;
  __setRunner(null);
});

function fakeFetch(
  responder: (url: string, init: RequestInit) => {
    ok: boolean;
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  },
): { fetchFn: typeof fetch; calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init: init ?? {}, body: init?.body ? JSON.parse(init.body as string) : undefined });
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

const okContent = (content: string) => ({
  ok: true,
  body: { choices: [{ message: { role: "assistant", content } }] },
});

describe("resolveDeepseekKey", () => {
  it("prefers the explicit key over env and Keychain", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env";
    expect(await resolveDeepseekKey("sk-explicit")).toBe("sk-explicit");
  });

  it("falls back to DEEPSEEK_API_KEY env", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env";
    expect(await resolveDeepseekKey()).toBe("sk-env");
  });

  it("falls back to the Keychain when no env var is set", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    __setRunner(async () => ({ stdout: "sk-keychain\n", stderr: "" }));
    expect(await resolveDeepseekKey()).toBe("sk-keychain");
  });

  it("throws DeepseekKeyMissingError when nothing is configured", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    __setRunner(async () => {
      throw Object.assign(new Error("not found"), { code: 44, stderr: "could not be found" });
    });
    await expect(resolveDeepseekKey()).rejects.toBeInstanceOf(DeepseekKeyMissingError);
  });
});

describe("DeepseekClient.chatJson", () => {
  it("returns the assistant content and sends the JSON-mode request shape", async () => {
    const { fetchFn, calls } = fakeFetch(() => okContent('{"actions":[]}'));
    const c = new DeepseekClient({ apiKey: "sk-ds-test", fetchFn });
    const out = await c.chatJson({ system: "you are a test", userText: "do the thing" });
    expect(out).toBe('{"actions":[]}');

    const call = calls[0]!;
    expect(call.url).toBe("https://api.deepseek.com/chat/completions");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ds-test");
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect(call.body.messages).toEqual([
      { role: "system", content: "you are a test" },
      { role: "user", content: "do the thing" },
    ]);
  });

  it("defaults the model to deepseek-chat", async () => {
    delete process.env.SECRETARY_DEEPSEEK_MODEL;
    const { fetchFn, calls } = fakeFetch(() => okContent("{}"));
    const c = new DeepseekClient({ apiKey: "k", fetchFn });
    await c.chatJson({ system: "s", userText: "u" });
    expect(calls[0]!.body.model).toBe("deepseek-chat");
  });

  it("honours the SECRETARY_DEEPSEEK_MODEL env override", async () => {
    process.env.SECRETARY_DEEPSEEK_MODEL = "deepseek-v4-flash";
    const { fetchFn, calls } = fakeFetch(() => okContent("{}"));
    const c = new DeepseekClient({ apiKey: "k", fetchFn });
    await c.chatJson({ system: "s", userText: "u" });
    expect(calls[0]!.body.model).toBe("deepseek-v4-flash");
  });

  it("honours an explicit per-call model override", async () => {
    delete process.env.SECRETARY_DEEPSEEK_MODEL;
    const { fetchFn, calls } = fakeFetch(() => okContent("{}"));
    const c = new DeepseekClient({ apiKey: "k", fetchFn, model: "deepseek-reasoner" });
    await c.chatJson({ system: "s", userText: "u", model: "deepseek-v4-flash" });
    expect(calls[0]!.body.model).toBe("deepseek-v4-flash");
  });

  it("throws DeepseekApiError on non-200", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: false,
      status: 401,
      body: { error: { message: "bad key" } },
    }));
    const c = new DeepseekClient({ apiKey: "k", fetchFn, maxRetries: 0 });
    await expect(c.chatJson({ system: "s", userText: "u" })).rejects.toBeInstanceOf(DeepseekApiError);
  });

  it("throws DeepseekApiError when the assistant message is empty", async () => {
    const { fetchFn } = fakeFetch(() => ({ ok: true, body: { choices: [] } }));
    const c = new DeepseekClient({ apiKey: "k", fetchFn, maxRetries: 0 });
    await expect(c.chatJson({ system: "s", userText: "u" })).rejects.toBeInstanceOf(DeepseekApiError);
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1) return { ok: false, status: 429, headers: { "retry-after": "0" }, body: {} };
      return okContent("{}");
    });
    const c = new DeepseekClient({ apiKey: "k", fetchFn, maxRetries: 2 });
    await c.chatJson({ system: "s", userText: "u" });
    expect(n).toBe(2);
  });
});
