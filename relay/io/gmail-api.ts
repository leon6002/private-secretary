// Gmail v1 wire layer. Direct REST against gmail.googleapis.com using
// the per-mailbox OAuth tokens stored in Keychain (relay/io/google-oauth.ts
// loads + refreshes them).
//
// What lives here:
//   - GmailClient bound to ONE mailbox email (the bearer token comes from
//     getAccessToken(email) on every call, so refresh-on-expiry is auto)
//   - Typed wrappers for: getProfile, history.list (incremental delta by
//     historyId), messages.list / messages.get, threads.get,
//     drafts.create, messages.attachments.get
//   - Retries 429/5xx with Retry-After (matches the SlackClient policy)
//
// Multi-account scheduling lives in relay/sources/gmail-direct.ts —
// instantiate one GmailClient per mailbox there.

import { getBearerToken } from "./google-oauth.js";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export class GmailApiError extends Error {
  constructor(
    public method: string,
    public httpStatus: number,
    public body: unknown,
  ) {
    super(`Gmail ${method} failed: HTTP ${httpStatus}`);
    this.name = "GmailApiError";
  }
}

// ─── shapes (subset of the API; only fields we use are typed) ──────

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartBody {
  size?: number;
  data?: string; // base64url-encoded inline body
  attachmentId?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string; // ms since epoch (string)
  payload?: GmailMessagePart;
  sizeEstimate?: number;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
}

export interface GmailMessagesListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHistoryRecord {
  id: string;
  messages?: Array<{ id: string; threadId: string }>;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
  messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
}

export interface GmailHistoryListResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId: string; // current historyId at the time of the call
}

export interface GmailDraftCreateResponse {
  id: string;
  message: GmailMessage;
}

// ─── client ────────────────────────────────────────────────────────

export interface GmailClientOptions {
  email: string; // mailbox this client is bound to
  fetchFn?: typeof fetch;
  baseUrl?: string;
  maxRetries?: number;
  // For tests that don't want to hit the OAuth token store at all,
  // pass a fixed token. In prod this is undefined and the client
  // calls getBearerToken(email) on every request (cheap — cached).
  tokenOverride?: string;
}

export class GmailClient {
  private readonly email: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly tokenOverride?: string;
  // Per-client serial chain so a single mailbox doesn't issue concurrent
  // requests (Gmail's quota is per-user; staying serial keeps things
  // simple and avoids rate-limit thrashing under bursty polling).
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(opts: GmailClientOptions) {
    this.email = opts.email;
    this.baseUrl = opts.baseUrl ?? GMAIL_API_BASE;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 3;
    this.tokenOverride = opts.tokenOverride;
  }

  private async token(): Promise<string> {
    if (this.tokenOverride !== undefined) return this.tokenOverride;
    return getBearerToken(this.email);
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const result = this.inFlight.then(() => this.callRaw<T>(method, path, body));
    this.inFlight = result.catch(() => undefined);
    return result;
  }

  private async callRaw<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.token()}`,
      };
      let payload: BodyInit | undefined;
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
      const resp = await this.fetchFn(url, { method, headers, body: payload });
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfterHeader = resp.headers.get("Retry-After");
        const wait = retryAfterHeader
          ? parseFloat(retryAfterHeader) * 1000
          : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
        lastErr = new Error(`Gmail ${path} HTTP ${resp.status}`);
        continue;
      }
      if (!resp.ok) {
        let errBody: unknown = null;
        try {
          errBody = await resp.json();
        } catch {
          errBody = await resp.text();
        }
        throw new GmailApiError(path, resp.status, errBody);
      }
      return (await resp.json()) as T;
    }
    throw lastErr ?? new Error(`Gmail ${path} exhausted retries`);
  }

  // ─── typed endpoints ──────────────────────────────────────────

  async getProfile(): Promise<GmailProfile> {
    return this.call("GET", "/users/me/profile");
  }

  // Server-side incremental: returns every history record since
  // startHistoryId. Returns the current historyId so the caller can
  // advance its cursor.
  async historyList(opts: {
    startHistoryId: string;
    historyTypes?: string[]; // messageAdded, labelAdded, etc
    labelId?: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<GmailHistoryListResponse> {
    const qs = new URLSearchParams({
      startHistoryId: opts.startHistoryId,
      maxResults: String(opts.maxResults ?? 500),
    });
    for (const t of opts.historyTypes ?? []) qs.append("historyTypes", t);
    if (opts.labelId) qs.set("labelId", opts.labelId);
    if (opts.pageToken) qs.set("pageToken", opts.pageToken);
    return this.call("GET", `/users/me/history?${qs.toString()}`);
  }

  // Paginate history.list internally until exhausted, returning a single
  // flattened array of records. Caller still gets the final historyId via
  // the second return slot so they can advance their cursor.
  async listAllHistory(opts: {
    startHistoryId: string;
    historyTypes?: string[];
    maxResultsPerPage?: number;
  }): Promise<{ records: GmailHistoryRecord[]; currentHistoryId: string }> {
    let pageToken: string | undefined;
    const records: GmailHistoryRecord[] = [];
    let currentHistoryId = opts.startHistoryId;
    while (true) {
      const resp = await this.historyList({
        startHistoryId: opts.startHistoryId,
        historyTypes: opts.historyTypes,
        pageToken,
        maxResults: opts.maxResultsPerPage,
      });
      if (resp.history) records.push(...resp.history);
      currentHistoryId = resp.historyId;
      pageToken = resp.nextPageToken;
      if (!pageToken) break;
    }
    return { records, currentHistoryId };
  }

  // List message IDs by query (e.g. "newer_than:30d -in:draft to:me").
  // Used for the first-ever sync seed: we pull recent threads, derive
  // the starting historyId, and stop relying on this after that.
  async messagesList(opts: {
    q?: string;
    labelIds?: string[];
    maxResults?: number;
    pageToken?: string;
    includeSpamTrash?: boolean;
  }): Promise<GmailMessagesListResponse> {
    const qs = new URLSearchParams();
    if (opts.q) qs.set("q", opts.q);
    for (const l of opts.labelIds ?? []) qs.append("labelIds", l);
    if (opts.maxResults != null) qs.set("maxResults", String(opts.maxResults));
    if (opts.pageToken) qs.set("pageToken", opts.pageToken);
    if (opts.includeSpamTrash) qs.set("includeSpamTrash", "true");
    return this.call("GET", `/users/me/messages?${qs.toString()}`);
  }

  async getMessage(opts: {
    id: string;
    format?: "minimal" | "metadata" | "full" | "raw";
    metadataHeaders?: string[];
  }): Promise<GmailMessage> {
    const qs = new URLSearchParams({ format: opts.format ?? "full" });
    for (const h of opts.metadataHeaders ?? []) qs.append("metadataHeaders", h);
    return this.call("GET", `/users/me/messages/${opts.id}?${qs.toString()}`);
  }

  async getThread(opts: {
    id: string;
    format?: "minimal" | "metadata" | "full";
  }): Promise<GmailThread> {
    const qs = new URLSearchParams({ format: opts.format ?? "full" });
    return this.call("GET", `/users/me/threads/${opts.id}?${qs.toString()}`);
  }

  // Returns the raw bytes of an attachment, base64url-decoded.
  async getAttachment(opts: {
    messageId: string;
    attachmentId: string;
  }): Promise<Uint8Array> {
    const data = await this.call<{ data: string; size?: number }>(
      "GET",
      `/users/me/messages/${opts.messageId}/attachments/${opts.attachmentId}`,
    );
    return decodeBase64Url(data.data);
  }

  // Create a draft. raw is base64url-encoded RFC 5322 message bytes.
  // Use buildRawMimeMessage() below to assemble.
  async createDraft(opts: { raw: string; threadId?: string }): Promise<GmailDraftCreateResponse> {
    const body: { message: { raw: string; threadId?: string } } = {
      message: { raw: opts.raw },
    };
    if (opts.threadId) body.message.threadId = opts.threadId;
    return this.call("POST", "/users/me/drafts", body);
  }
}

// ─── helpers exposed for both prod + tests ─────────────────────────

// Gmail uses RFC 4648 §5 base64url WITHOUT padding for body / attachment
// data. atob / Buffer.from('base64') need both '+' / '/' and padding.
export function decodeBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return new Uint8Array(Buffer.from(padded + pad, "base64"));
}

export function encodeBase64Url(bytes: Uint8Array | string): string {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Pull a header out of a Gmail message payload. Case-insensitive name
// match; returns null if absent.
export function getHeader(
  payload: GmailMessagePart | undefined,
  name: string,
): string | null {
  if (!payload?.headers) return null;
  const lower = name.toLowerCase();
  for (const h of payload.headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return null;
}

// Recursively collect every "leaf" body that has inline data (text/* parts
// for the message body). Useful for rendering a message to text. Doesn't
// download attachmentId-only bodies — caller uses getAttachment for those.
export function collectInlineParts(
  part: GmailMessagePart | undefined,
): Array<{ mimeType: string; text: string }> {
  const out: Array<{ mimeType: string; text: string }> = [];
  if (!part) return out;
  if (part.body?.data) {
    const bytes = decodeBase64Url(part.body.data);
    out.push({
      mimeType: part.mimeType ?? "text/plain",
      text: new TextDecoder().decode(bytes),
    });
  }
  for (const child of part.parts ?? []) {
    out.push(...collectInlineParts(child));
  }
  return out;
}
