import { describe, it, expect } from "vitest";
import {
  collectInlineParts,
  decodeBase64Url,
  encodeBase64Url,
  getHeader,
  GmailApiError,
  GmailClient,
  type GmailMessagePart,
} from "./gmail-api.js";

// Build an in-memory fetch that maps request paths to canned responses.
function fakeFetch(
  responder: (url: string, init: RequestInit) => {
    ok: boolean;
    status?: number;
    headers?: Record<string, string>;
    body: unknown;
  },
): { fetchFn: typeof fetch; calls: Array<{ url: string; method: string; body?: string }> } {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const r = responder(url, init ?? {});
    const headers = new Map(Object.entries(r.headers ?? {}));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      headers: { get: (k: string) => headers.get(k) ?? null } as Headers,
      json: async () => r.body,
      text: async () =>
        typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    } as Response;
  };
  return { fetchFn, calls };
}

describe("decodeBase64Url / encodeBase64Url roundtrip", () => {
  it("handles strings without padding ('-' for '+', '_' for '/')", () => {
    const original = "hello, 世界! a~b/c+d?";
    const encoded = encodeBase64Url(original);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    const decoded = new TextDecoder().decode(decodeBase64Url(encoded));
    expect(decoded).toBe(original);
  });
});

describe("getHeader", () => {
  it("returns the header value case-insensitively", () => {
    const part: GmailMessagePart = {
      headers: [
        { name: "From", value: "leo@taiv.tv" },
        { name: "Subject", value: "hello" },
      ],
    };
    expect(getHeader(part, "from")).toBe("leo@taiv.tv");
    expect(getHeader(part, "SUBJECT")).toBe("hello");
    expect(getHeader(part, "Cc")).toBeNull();
  });
});

describe("collectInlineParts", () => {
  it("collects text/* bodies recursively, decoding base64url", () => {
    const part: GmailMessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: encodeBase64Url("plain body") },
        },
        {
          mimeType: "multipart/related",
          parts: [
            {
              mimeType: "text/html",
              body: { data: encodeBase64Url("<b>html</b>") },
            },
          ],
        },
      ],
    };
    const parts = collectInlineParts(part);
    expect(parts.map((p) => p.text)).toEqual(["plain body", "<b>html</b>"]);
  });
});

describe("GmailClient — wire layer", () => {
  it("getProfile sends bearer + parses response", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: {
        emailAddress: "leo@taiv.tv",
        messagesTotal: 10800,
        threadsTotal: 7307,
        historyId: "12345",
      },
    }));
    const client = new GmailClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "test-bearer",
    });
    const p = await client.getProfile();
    expect(p.historyId).toBe("12345");
    expect(calls[0]?.url).toMatch(/\/users\/me\/profile$/);
    expect(calls[0]?.method).toBe("GET");
  });

  it("historyList builds the right querystring", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { history: [], historyId: "9999" },
    }));
    const client = new GmailClient({ email: "leo@taiv.tv", fetchFn, tokenOverride: "t" });
    await client.historyList({
      startHistoryId: "100",
      historyTypes: ["messageAdded", "labelAdded"],
      maxResults: 250,
    });
    const url = calls[0]?.url ?? "";
    expect(url).toContain("startHistoryId=100");
    expect(url).toMatch(/historyTypes=messageAdded.*historyTypes=labelAdded/);
    expect(url).toContain("maxResults=250");
  });

  it("listAllHistory paginates internally until nextPageToken is empty", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1) {
        return {
          ok: true,
          body: {
            history: [{ id: "1" }, { id: "2" }],
            nextPageToken: "tok",
            historyId: "200",
          },
        };
      }
      return {
        ok: true,
        body: { history: [{ id: "3" }], historyId: "300" },
      };
    });
    const client = new GmailClient({ email: "leo@taiv.tv", fetchFn, tokenOverride: "t" });
    const { records, currentHistoryId } = await client.listAllHistory({
      startHistoryId: "100",
    });
    expect(records.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(currentHistoryId).toBe("300");
  });

  it("getMessage uses format=full by default and parses payload", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: {
        id: "M1",
        threadId: "T1",
        internalDate: "1781000000000",
        payload: {
          headers: [{ name: "Subject", value: "test" }],
          body: { data: encodeBase64Url("hello") },
        },
      },
    }));
    const client = new GmailClient({ email: "leo@taiv.tv", fetchFn, tokenOverride: "t" });
    const m = await client.getMessage({ id: "M1" });
    expect(m.id).toBe("M1");
    expect(calls[0]?.url).toContain("format=full");
  });

  it("getAttachment decodes base64url bytes", async () => {
    const original = "PDFDATA-binary";
    const { fetchFn } = fakeFetch(() => ({
      ok: true,
      body: { data: encodeBase64Url(original), size: original.length },
    }));
    const client = new GmailClient({ email: "leo@taiv.tv", fetchFn, tokenOverride: "t" });
    const bytes = await client.getAttachment({ messageId: "M1", attachmentId: "A1" });
    expect(new TextDecoder().decode(bytes)).toBe(original);
  });

  it("createDraft POSTs JSON with the raw message + optional threadId", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      ok: true,
      body: { id: "D1", message: { id: "M1", threadId: "T1" } },
    }));
    const client = new GmailClient({ email: "leo@taiv.tv", fetchFn, tokenOverride: "t" });
    await client.createDraft({ raw: "encoded-bytes", threadId: "T1" });
    expect(calls[0]?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.message.raw).toBe("encoded-bytes");
    expect(body.message.threadId).toBe("T1");
  });

  it("retries on HTTP 429 then succeeds", async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1)
        return { ok: false, status: 429, headers: { "Retry-After": "0" }, body: {} };
      return {
        ok: true,
        body: { emailAddress: "x", messagesTotal: 1, threadsTotal: 1, historyId: "1" },
      };
    });
    const client = new GmailClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
      maxRetries: 2,
    });
    const p = await client.getProfile();
    expect(p.historyId).toBe("1");
    expect(n).toBe(2);
  });

  it("throws GmailApiError with status + body on permanent failure", async () => {
    const { fetchFn } = fakeFetch(() => ({
      ok: false,
      status: 404,
      body: { error: { code: 404, message: "Not Found" } },
    }));
    const client = new GmailClient({
      email: "leo@taiv.tv",
      fetchFn,
      tokenOverride: "t",
      maxRetries: 0,
    });
    await expect(client.getProfile()).rejects.toBeInstanceOf(GmailApiError);
  });
});
