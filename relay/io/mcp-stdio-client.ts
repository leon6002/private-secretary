// Minimal MCP stdio client. Talks line-delimited JSON-RPC 2.0 over a child
// process's stdin/stdout per the Model Context Protocol stdio transport.
//
// Reused by:
//   - relay/io/wechat-cli.ts (drives ylytdeng/wechat-decrypt locally)
//   - Future MCP-backed I/O the secretary picks up
//
// Why not the official @modelcontextprotocol/sdk:
//   The wire protocol is small enough that hand-rolling beats pulling
//   another dependency tree into the cockpit. ~150 LOC here vs ~30 packages.
//   Keeps relay/io free of external SDK surface.
//
// Lifecycle:
//   const client = new McpStdioClient({ command, args })
//   await client.initialize()             // sends initialize + initialized notify
//   const out = await client.callTool("get_chat_history", { chat_name: "..." })
//   await client.close()                  // sends SIGTERM, waits for exit
//
// Concurrency:
//   Sends are serialized internally — each callTool awaits its own response
//   before yielding. Multiple concurrent callers are safe; ids are unique.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: { result?: string } | Record<string, unknown>;
}

export interface McpStdioClientOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  // Caller can override the client name/version that the server sees.
  clientName?: string;
  clientVersion?: string;
  // Per-request timeout. A hung server (or one that never answers a given
  // id) would otherwise leave the caller's promise pending forever — which
  // is exactly how a scan tick can hold the state lock past the stale
  // threshold. Defaults to DEFAULT_REQUEST_TIMEOUT_MS.
  requestTimeoutMs?: number;
}

// Generous default: a local decrypt of a large media blob can take a few
// seconds, but no legitimate call runs for minutes. The cap turns an
// indefinite hang into a normal rejected promise the caller can recover from.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Extract every balanced, string-aware {...} object from a line and return
// those that parse as JSON. Defends against a server that pollutes stdout
// (the JSON-RPC channel) with stray text — a clean line yields its one object;
// a polluted line (`progress{json}`, `{json}trailing`, or several objects)
// yields whatever valid objects it contains, ignoring the noise. Exported for
// testing. Bounded: a single linear scan of the line.
export function recoverJsonObjects(line: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(line.slice(start, i + 1)));
        } catch {
          // a balanced {...} that isn't valid JSON (e.g. stray braces in
          // progress text) — skip it.
        }
        start = -1;
      }
    }
  }
  return out;
}

export class McpStdioClient {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, {
    resolve: (v: JsonRpcResponse) => void;
    reject: (e: Error) => void;
  }>();
  private closed = false;
  private closeReason: Error | null = null;
  private exitKill: (() => void) | null = null;

  constructor(private readonly opts: McpStdioClientOptions) {}

  // Spawn the child process. Subsequent initialize() does the JSON-RPC
  // handshake. Split so callers can hook child events before any traffic.
  start(): void {
    if (this.child) throw new Error("McpStdioClient already started");
    const child = spawn(this.opts.command, this.opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.opts.env ?? process.env,
    });
    this.child = child;
    // Don't let the child's own handle keep the parent event loop alive.
    child.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    // stderr is informational (FastMCP prints "[DBCache] reused 1 cached..."
    // and similar). We drop it on the floor — surfaces only when the child
    // exits non-zero so callers see *something* in errors.
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    // stderr is never awaited — never let it hold the loop open.
    (child.stderr as Readable & { unref?: () => void }).unref?.();
    // stdout is ref'd only while a request is outstanding (see updateLoopRef).
    // Without this, an idle MCP child's piped stdout keeps a one-shot script's
    // node process alive forever — the leak that piled up hung mcp_server.py
    // children. Start idle (unref'd).
    this.updateLoopRef();
    // Backstop: take the child down with the parent. kill() is synchronous, so
    // it's valid inside an 'exit' handler (an async close() could not finish).
    this.exitKill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    };
    process.once("exit", this.exitKill);

    child.on("error", (e) => this.shutdown(e));
    child.on("exit", (code) => {
      if (this.closed) return;
      const err = new Error(
        `MCP server exited unexpectedly (code=${code}). stderr:\n${stderr}`,
      );
      this.shutdown(err);
    });
  }

  // JSON-RPC framing per MCP stdio: one JSON object per line on stdout. But a
  // misbehaving server may print non-JSON to stdout (e.g. decrypt progress that
  // should have gone to stderr); when that text is flushed mid-frame it splices
  // INTO the response line (`进度: 5/10{json}`), so a whole-line JSON.parse
  // fails and the response is lost → the request hangs to its timeout. We
  // recover by extracting any balanced {...} object embedded in the line.
  private consume(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      for (const obj of recoverJsonObjects(line)) {
        const msg = obj as JsonRpcResponse;
        if (typeof msg.id !== "number") continue; // notification echo etc.
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue; // stale id
        this.pending.delete(msg.id);
        this.updateLoopRef();
        waiter.resolve(msg);
      }
    }
  }

  // Keep the event loop alive ONLY while a request is outstanding: ref the
  // stdout pipe when work is pending, unref it when idle. This lets a one-shot
  // script exit once its awaits resolve (idle → unref'd → nothing holds the
  // loop → 'exit' fires → the backstop kills the child), while the daemon —
  // which has its own timers — keeps the shared client responsive.
  private updateLoopRef(): void {
    const out = this.child?.stdout as
      | (Readable & { ref?: () => void; unref?: () => void })
      | undefined;
    if (!out) return;
    if (this.pending.size > 0) out.ref?.();
    else out.unref?.();
  }

  private send(req: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.child) throw new Error("McpStdioClient not started");
    if (this.closed) throw this.closeReason ?? new Error("McpStdioClient closed");
    this.child.stdin.write(JSON.stringify(req) + "\n");
  }

  private request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    if (this.closed) return Promise.reject(this.closeReason ?? new Error("closed"));
    const id = this.nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Drop the waiter and reject; a late response then hits "stale id"
        // in consume() and is ignored.
        if (this.pending.delete(id)) {
          this.updateLoopRef();
          reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.(); // a pending timeout must never keep the process alive
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    this.updateLoopRef(); // a request is now outstanding — keep the loop alive
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async initialize(): Promise<void> {
    if (!this.child) this.start();
    const resp = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: this.opts.clientName ?? "taiv-secretary",
        version: this.opts.clientVersion ?? "0.1",
      },
    });
    if (resp.error) throw new Error(`MCP initialize failed: ${resp.error.message}`);
    // initialized notification — no response expected
    this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  // Invoke a tool. Returns the structured content's `result` string if
  // present (FastMCP convention), else stitches text blocks from `content`,
  // else stringifies whatever the server returned. Throws on JSON-RPC errors
  // and on tool-level `isError: true`.
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const resp = await this.request("tools/call", { name, arguments: args });
    if (resp.error) throw new Error(`MCP tool ${name} failed: ${resp.error.message}`);
    const result = resp.result as McpToolCallResult | undefined;
    if (!result) return "";
    if (result.isError) {
      const msg =
        (result.content?.find((c) => c.type === "text")?.text ?? "tool error").trim();
      throw new Error(`MCP tool ${name} returned isError: ${msg}`);
    }
    const sc = result.structuredContent;
    if (sc && typeof (sc as { result?: unknown }).result === "string") {
      return (sc as { result: string }).result;
    }
    if (result.content) {
      return result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
    return JSON.stringify(result);
  }

  private shutdown(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const { reject } of this.pending.values()) reject(reason);
    this.pending.clear();
    this.updateLoopRef(); // nothing pending — release the loop
  }

  async close(): Promise<void> {
    if (!this.child || this.closed) return;
    this.closed = true;
    if (this.exitKill) {
      process.removeListener("exit", this.exitKill);
      this.exitKill = null;
    }
    const child = this.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin.end();
        child.kill("SIGTERM");
      } catch {
        // already dead
      }
    });
  }
}
