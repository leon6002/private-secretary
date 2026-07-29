// The single chokepoint for reading WeChat data. Every wechat read goes
// through here: the persona-bootstrap skill, the (future)
// `relay/sources/wechat-1to1.ts` source, and the cockpit's wechat panel
// all reuse the same arg-assembly, error classification, and runner-
// injection so we don't grow two divergent call sites.
//
// BACKEND: `ylytdeng/wechat-decrypt` MCP server, driven via stdio
// (FastMCP / JSON-RPC 2.0). Path validated by spike 2026-06-13;
// migration spec: `specs/wechat-decrypt-migration.md`. The older wxecho
// backend was retired here because it dropped 5 message channels
// (file/link/namecard/quoted-reply/system) and rendered images as bare
// placeholders, violating CLAUDE.md "messages are never text-only".
//
// WRAPPER API: unchanged from the wxecho era — `wechatContacts(query?)`
// and `wechatHistory(chat, opts)` return formatted Chinese text the
// LLM consumes verbatim. The MCP server already returns the same
// human-readable format, so filterChatText / filterContactsText are
// no longer needed (kept as deprecated exports so existing tests still
// link). Date / limit filtering is now done server-side via
// get_chat_history's start_time / limit args.
//
// New capabilities the MCP backend unlocks (used by persona-bootstrap +
// cockpit + future source):
//   - wechatSearch(keyword, opts)        — search_messages
//   - wechatDecodeImage(chat, local_id)  — decode_image (real JPG path)
//   - wechatDecodeFile / Transfer / Refer / Location / RecordItem
//   - wechatNewMessages() works (was throw before) — wraps get_new_messages
//     with a persisted cursor on top of the server's RAM-only one
//
// SETUP: the MCP server (mcp_server.py) is spawned lazily on first call;
// it expects WeChat.app running + the codesign / keys / decrypt setup
// from `specs/wechat-local-decrypt.md` already done. If the server fails
// to initialize, callers see WechatCliNotInitializedError (error class
// name preserved from the wxecho era for skill compatibility).

import { McpStdioClient } from "./mcp-stdio-client.js";

// ─── error classes (names preserved for downstream callers) ─────────

export class WechatCliNotInitializedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WechatCliNotInitializedError";
  }
}

// Kept exported for back-compat. The MCP backend covers all the methods
// the old wxecho backend raised this for (sessions, new-messages, unread).
export class WechatCliNotSupportedError extends Error {
  constructor(method: string) {
    super(`${method}() is not supported by the wechat backend.`);
    this.name = "WechatCliNotSupportedError";
  }
}

// ─── runner contract (injectable for tests) ─────────────────────────

// A runner takes an MCP tool name + arguments map and returns the
// formatted text the server emits. Tests inject a Map-backed fake; prod
// uses an McpStdioClient instance pinned to the wechat-decrypt server.
export interface WechatCliRunner {
  (tool: string, args: Record<string, unknown>): Promise<string>;
}

// ─── default runner: spawn-and-call mcp_server.py once per process ──

// Resolved at first use. Env override exists for the standalone case where
// the server isn't installed at the default path.
const DEFAULT_SERVER_PATH =
  process.env.WECHAT_MCP_SERVER_PATH ??
  `${process.env.HOME ?? ""}/tools/wechat-decrypt/mcp_server.py`;

const DEFAULT_PYTHON =
  process.env.WECHAT_MCP_PYTHON ??
  `${process.env.HOME ?? ""}/tools/wechat-decrypt/.venv/bin/python3`;

let sharedClient: McpStdioClient | null = null;
let sharedInit: Promise<McpStdioClient> | null = null;
let shutdownHandlersInstalled = false;

// Tear the child down on process exit so we don't leak FDs. Installed ONCE
// per process — a previous bug re-registered these on every init attempt, so
// repeated init failures piled up listeners (MaxListenersExceededWarning).
function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const exitHandler = (): void => {
    void sharedClient?.close();
  };
  process.once("exit", exitHandler);
  process.once("SIGINT", () => {
    exitHandler();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    exitHandler();
    process.exit(143);
  });
}

async function getSharedClient(): Promise<McpStdioClient> {
  if (sharedClient) return sharedClient;
  if (sharedInit) return sharedInit;
  installShutdownHandlers();
  sharedInit = (async () => {
    const client = new McpStdioClient({
      command: DEFAULT_PYTHON,
      args: [DEFAULT_SERVER_PATH],
      clientName: "taiv-secretary-wechat",
      // decode_image (V2 .dat: AES-ECB + XOR, plus a cold server start) can run
      // well past the 30s default; other calls finish in well under this, so a
      // higher ceiling only matters when something genuinely hangs.
      requestTimeoutMs: Number(process.env.WECHAT_MCP_TIMEOUT_MS) || 120_000,
    });
    try {
      await client.initialize();
    } catch (e) {
      // Tear down the spawned child + its stdio listeners; a failed init
      // otherwise leaks the process. Then let the next call retry cleanly.
      sharedInit = null;
      await client.close().catch(() => {});
      throw new WechatCliNotInitializedError(
        `wechat-decrypt MCP server failed to initialize: ${(e as Error).message}\n` +
          `Verify ${DEFAULT_PYTHON} and ${DEFAULT_SERVER_PATH} exist and that WeChat.app is running.`,
      );
    }
    sharedClient = client;
    return client;
  })();
  return sharedInit;
}

const defaultRunner: WechatCliRunner = async (tool, args) => {
  const client = await getSharedClient();
  return client.callTool(tool, args);
};

let activeRunner: WechatCliRunner = defaultRunner;

export function __setRunner(runner: WechatCliRunner | null): void {
  activeRunner = runner ?? defaultRunner;
}

// Translate JSON-RPC / MCP errors into the typed errors the skill expects.
async function call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    return await activeRunner(tool, args);
  } catch (e) {
    if (e instanceof WechatCliNotInitializedError) throw e;
    const msg = (e as Error).message ?? String(e);
    // Server-side "not initialized" / "keys missing" surfaces as a generic
    // error string. Match the same patterns the wxecho wrapper looked for.
    if (/未找到密钥|未解密|找不到.{0,8}数据库|密钥|decrypt|keys/i.test(msg)) {
      throw new WechatCliNotInitializedError(
        `wechat-decrypt: ${msg}\nMake sure WeChat.app is running and the decrypt prerequisites are met (see specs/wechat-local-decrypt.md).`,
      );
    }
    throw e;
  }
}

// ─── options ────────────────────────────────────────────────────────

export interface WechatHistoryOptions {
  // ISO date or YYYY-MM-DD. Server-side filter via get_chat_history's
  // start_time. Accepts YYYY-MM-DD / YYYY-MM-DD HH:MM / YYYY-MM-DD HH:MM:SS.
  start?: string;
  // Same shape as start — server-side end_time. Lets a caller window an
  // older era (start + end) for persona-bootstrap historical samples.
  end?: string;
  // Server-side limit. The MCP server allows large values; default 50 in
  // upstream but we pass-through whatever the caller asks for.
  limit?: number;
  // Server-side offset for pagination.
  offset?: number;
  // Subset of message types. Upstream accepts: text, image, voice, video,
  // file, emoji, location, namecard, voip, system. None / undefined = all.
  msgTypes?: string[];
  // false (default) = newest first; true = oldest first.
  oldestFirst?: boolean;
  // Precise-match wxid. When set, this takes precedence over the `chat`
  // positional — upstream still uses it as the chat_name parameter, but
  // wxid is unambiguous so we route via wxid.
  wxid?: string;
}

export interface WechatSearchOptions {
  chatName?: string | string[];
  start?: string;
  end?: string;
  limit?: number;
  offset?: number;
}

// ─── tool wrappers ──────────────────────────────────────────────────

// Generic escape hatch — invoke any MCP tool by name with arbitrary args.
// Tests use this to verify pass-through. Skills and the cockpit should
// prefer the typed helpers below.
export async function wechatRaw(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  return call(tool, args);
}

// List contacts. Optional query matches against nickname / remark / wxid
// server-side. Default limit 200 keeps continuity with the wxecho-era
// behaviour (top-200 sessions table).
export async function wechatContacts(query?: string): Promise<string> {
  return call("get_contacts", { query: query ?? "", limit: 200 });
}

// List recent active sessions with last-message preview + unread counts.
// Distinct from contacts now — wxecho era aliased them because that
// backend only had one list verb.
export async function wechatSessions(opts: { limit?: number } = {}): Promise<string> {
  return call("get_recent_sessions", { limit: opts.limit ?? 20 });
}

// Get chat history for one contact. When opts.wxid is set we route via
// wxid (precise); otherwise the positional chat name does fuzzy match
// upstream. The MCP server handles ambiguity by picking the best match —
// no interactive prompt.
export async function wechatHistory(
  chat: string,
  opts: WechatHistoryOptions = {},
): Promise<string> {
  const chatName = opts.wxid ?? chat;
  const args: Record<string, unknown> = {
    chat_name: chatName,
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  };
  if (opts.start) args.start_time = opts.start;
  if (opts.end) args.end_time = opts.end;
  if (opts.oldestFirst) args.oldest_first = true;
  if (opts.msgTypes && opts.msgTypes.length > 0) args.msg_types = opts.msgTypes;
  return call("get_chat_history", args);
}

// Search messages across all chats or scoped to one/several chats.
export async function wechatSearch(
  keyword: string,
  opts: WechatSearchOptions = {},
): Promise<string> {
  const args: Record<string, unknown> = {
    keyword,
    limit: opts.limit ?? 20,
    offset: opts.offset ?? 0,
  };
  if (opts.chatName != null) args.chat_name = opts.chatName;
  if (opts.start) args.start_time = opts.start;
  if (opts.end) args.end_time = opts.end;
  return call("search_messages", args);
}

// Incremental "what's new since last call". The MCP server keeps a
// RAM-only cursor that resets on restart — see migration spec §risks.
// The caller (scan loop) persists the last-seen timestamp itself.
export async function wechatNewMessages(): Promise<string> {
  return call("get_new_messages", {});
}

// Unread digest — implemented as get_recent_sessions and let the caller
// filter; the server response includes per-session unread counts.
export async function wechatUnread(): Promise<string> {
  return call("get_recent_sessions", { limit: 50 });
}

// ─── media + rich-message decoders ──────────────────────────────────

// Decode an image message to its real local JPG path. Pair with
// wechatHistory output: each image line carries (local_id=N, ts=T).
export async function wechatDecodeImage(
  chat: string,
  localId: number,
): Promise<string> {
  return call("decode_image", { chat_name: chat, local_id: localId });
}

// Decode a file-attachment message ([文件] xxx.pdf) to its local path.
// create_time disambiguates across DB shards — pass the ts= from history.
export async function wechatDecodeFile(
  chat: string,
  localId: number,
  createTime: number = 0,
): Promise<string> {
  return call("decode_file_message", {
    chat_name: chat,
    local_id: localId,
    create_time: createTime,
  });
}

// ─── deprecated pure helpers, kept for back-compat with old tests ────

// These were JS-side filters needed when the wxecho backend returned the
// full chat blob and we trimmed locally. The MCP backend filters
// server-side; these are no longer called by production code but the
// existing test file still imports them as a sanity check.

export function filterContactsText(text: string, query: string): string {
  const lines = text.split("\n");
  const sepIdx = lines.findIndex((l) => /^-{5,}/.test(l));
  if (sepIdx < 0) return text;
  const header = lines.slice(0, sepIdx + 1);
  const rows = lines.slice(sepIdx + 1).filter((l) => l.length > 0 && l.includes(query));
  return [...header, ...rows].join("\n");
}

export function filterChatText(text: string, opts: WechatHistoryOptions): string {
  if (!opts.start && !opts.end && opts.limit == null) return text;
  const lines = text.split("\n");
  const firstMsgIdx = lines.findIndex((l) => /^\[\d{4}-\d{2}-\d{2} /.test(l));
  if (firstMsgIdx < 0) return text;
  const header = lines.slice(0, firstMsgIdx);
  const body = lines.slice(firstMsgIdx);
  interface Block {
    date: string;
    lines: string[];
  }
  const blocks: Block[] = [];
  for (const line of body) {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2})/);
    if (m) blocks.push({ date: m[1]!, lines: [line] });
    else if (blocks.length > 0) blocks[blocks.length - 1]!.lines.push(line);
  }
  let kept = blocks;
  if (opts.start) {
    const startDate = opts.start.slice(0, 10);
    kept = kept.filter((b) => b.date >= startDate);
  }
  if (opts.end) {
    const endDate = opts.end.slice(0, 10);
    kept = kept.filter((b) => b.date <= endDate);
  }
  if (opts.limit != null && opts.limit > 0) {
    kept = kept.slice(-opts.limit);
  }
  return [...header, ...kept.flatMap((b) => b.lines)].join("\n");
}
