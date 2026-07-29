import { describe, it, expect } from "vitest";
import { McpStdioClient, recoverJsonObjects } from "./mcp-stdio-client.js";

describe("recoverJsonObjects — survives stdout pollution", () => {
  const rpc = '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok"}]}}';
  const idOf = (xs: unknown[]) => xs.map((x) => (x as { id?: unknown }).id);

  it("parses a clean line (one object)", () => {
    expect(recoverJsonObjects(rpc)).toHaveLength(1);
    expect(idOf(recoverJsonObjects(rpc))).toEqual([3]);
  });

  it("recovers the response when progress text is spliced BEFORE it", () => {
    // the actual bug: decrypt progress printed to stdout, no newline, then the
    // JSON-RPC frame on the same line.
    expect(idOf(recoverJsonObjects("进度: 5/10 [DBCache] reused 3 cached DBs" + rpc))).toEqual([3]);
  });

  it("recovers the response when noise trails it", () => {
    expect(idOf(recoverJsonObjects(rpc + "进度: 6/10"))).toEqual([3]);
  });

  it("ignores stray braces in the noise prefix", () => {
    expect(idOf(recoverJsonObjects("oops {not json} progress " + rpc))).toEqual([3]);
  });

  it("does not get confused by braces inside JSON strings", () => {
    const tricky = '{"id":7,"result":{"text":"a } b { c"}}';
    expect(idOf(recoverJsonObjects("noise " + tricky))).toEqual([7]);
  });

  it("recovers multiple objects on one line", () => {
    expect(idOf(recoverJsonObjects(rpc + '\t{"id":4,"result":{}}'))).toEqual([3, 4]);
  });

  it("returns nothing for genuinely non-JSON noise", () => {
    expect(recoverJsonObjects("[DBCache] reused 1 cached decrypted DB")).toEqual([]);
  });
});

describe("McpStdioClient request timeout", () => {
  it("rejects (not hangs) when the server never answers", async () => {
    // `sleep` spawns fine but never speaks JSON-RPC, so the initialize
    // request gets no response. Without a timeout this would hang forever
    // — the bug that let a scan tick hold the state lock past the stale
    // threshold. With the cap it rejects promptly.
    const client = new McpStdioClient({
      command: "sleep",
      args: ["60"],
      requestTimeoutMs: 50,
    });
    await expect(client.initialize()).rejects.toThrow(/timed out/);
    await client.close();
  });
});
