import { afterEach, describe, expect, it } from "vitest";
import {
  __setRunner,
  filterChatText,
  filterContactsText,
  WechatCliNotInitializedError,
  WechatCliNotSupportedError,
  wechatContacts,
  wechatDecodeFile,
  wechatDecodeImage,
  wechatHistory,
  wechatNewMessages,
  wechatRaw,
  wechatSearch,
  wechatSessions,
  wechatUnread,
  type WechatCliRunner,
} from "./wechat-cli.js";

afterEach(() => __setRunner(null));

interface RunnerCall {
  tool: string;
  args: Record<string, unknown>;
}

// In-memory fake — records every call so tests can assert on the
// (tool, args) shape, returns whatever the test wants per tool.
function fakeRunner(
  responder: (call: RunnerCall) => string | Error,
): { runner: WechatCliRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: WechatCliRunner = async (tool, args) => {
    const call = { tool, args };
    calls.push(call);
    const out = responder(call);
    if (out instanceof Error) throw out;
    return out;
  };
  return { runner, calls };
}

// Sample chat-history output the MCP server emits — Chinese-formatted
// header + per-message lines. Real samples carry (local_id=N, ts=T) tags
// on rich-message lines; we don't parse them here, just verify pass-through.
const HISTORY_SAMPLE = `坦丁 (wxid_y30rici04nja32) 最近 5 条消息：
[2026-06-05 20:48:19] 我: 这确实没沟通好
[2026-06-05 20:48:25] 坦丁: 可没有耽误时间[Whimper]
[2026-06-05 20:48:44] 我 → [图片] (local_id=128, ts=1781329724)
[2026-06-05 20:49:11] 我 → [文件] 发票运单明细.pdf (local_id=129, ts=1781329751)
[2026-06-05 20:49:25] 坦丁: 收到`;

const CONTACTS_SAMPLE = `匹配到 2 个联系人：
1. 坦丁 (wxid_y30rici04nja32) — 备注: 坦丁, 108588 条消息
2. Leo.yang (yjn2013) — 备注: , 98122 条消息`;

const SESSIONS_SAMPLE = `最近会话 (20 个)：
1. 坦丁 (wxid_y30rici04nja32) — 5 条未读, 2026-06-13 20:57
2. Leo.yang (yjn2013) — 0 条未读, 2026-06-13 12:06`;

describe("wechatRaw — generic escape hatch", () => {
  it("forwards tool name + args verbatim and returns the runner's output", async () => {
    const { runner, calls } = fakeRunner(() => "raw text");
    __setRunner(runner);
    const out = await wechatRaw("get_chat_history", {
      chat_name: "坦丁",
      limit: 10,
    });
    expect(out).toBe("raw text");
    expect(calls).toEqual([
      { tool: "get_chat_history", args: { chat_name: "坦丁", limit: 10 } },
    ]);
  });
});

describe("wechatContacts — maps to MCP get_contacts", () => {
  it("no query → calls get_contacts with empty query + default limit 200", async () => {
    const { runner, calls } = fakeRunner(() => CONTACTS_SAMPLE);
    __setRunner(runner);
    const out = await wechatContacts();
    expect(out).toBe(CONTACTS_SAMPLE);
    expect(calls).toEqual([
      { tool: "get_contacts", args: { query: "", limit: 200 } },
    ]);
  });

  it("with query → passes through to upstream (no JS-side filtering)", async () => {
    const { runner, calls } = fakeRunner(() => CONTACTS_SAMPLE);
    __setRunner(runner);
    await wechatContacts("Leo.yang");
    expect(calls[0]).toEqual({
      tool: "get_contacts",
      args: { query: "Leo.yang", limit: 200 },
    });
  });

  it("CJK/emoji queries pass through unchanged via JSON-RPC", async () => {
    const { runner, calls } = fakeRunner(() => CONTACTS_SAMPLE);
    __setRunner(runner);
    await wechatContacts("乐乐❤️");
    expect(calls[0]?.args?.query).toBe("乐乐❤️");
  });
});

describe("wechatSessions — distinct from contacts now", () => {
  it("calls get_recent_sessions with default limit 20 (not aliased to contacts)", async () => {
    const { runner, calls } = fakeRunner(() => SESSIONS_SAMPLE);
    __setRunner(runner);
    const out = await wechatSessions();
    expect(out).toBe(SESSIONS_SAMPLE);
    expect(calls).toEqual([{ tool: "get_recent_sessions", args: { limit: 20 } }]);
  });

  it("respects an explicit limit", async () => {
    const { runner, calls } = fakeRunner(() => "");
    __setRunner(runner);
    await wechatSessions({ limit: 5 });
    expect(calls[0]?.args).toEqual({ limit: 5 });
  });
});

describe("wechatHistory — server-side filters via get_chat_history", () => {
  it("default call: positional chat → chat_name, default limit 50 + offset 0", async () => {
    const { runner, calls } = fakeRunner(() => HISTORY_SAMPLE);
    __setRunner(runner);
    const out = await wechatHistory("坦丁");
    expect(out).toBe(HISTORY_SAMPLE);
    expect(calls[0]).toEqual({
      tool: "get_chat_history",
      args: { chat_name: "坦丁", limit: 50, offset: 0 },
    });
  });

  it("opts.wxid overrides positional chat for precise match", async () => {
    const { runner, calls } = fakeRunner(() => HISTORY_SAMPLE);
    __setRunner(runner);
    await wechatHistory("anything", { wxid: "wxid_y30rici04nja32" });
    expect(calls[0]?.args?.chat_name).toBe("wxid_y30rici04nja32");
  });

  it("passes through start / end / limit / offset / oldest_first / msg_types", async () => {
    const { runner, calls } = fakeRunner(() => HISTORY_SAMPLE);
    __setRunner(runner);
    await wechatHistory("坦丁", {
      start: "2026-06-01",
      end: "2026-06-13",
      limit: 200,
      offset: 100,
      oldestFirst: true,
      msgTypes: ["text", "image"],
    });
    expect(calls[0]?.args).toEqual({
      chat_name: "坦丁",
      limit: 200,
      offset: 100,
      start_time: "2026-06-01",
      end_time: "2026-06-13",
      oldest_first: true,
      msg_types: ["text", "image"],
    });
  });

  it("CJK + emoji + spaces in chat names pass through unchanged", async () => {
    const { runner, calls } = fakeRunner(() => HISTORY_SAMPLE);
    __setRunner(runner);
    await wechatHistory("张三 👋 AI交流群");
    expect(calls[0]?.args?.chat_name).toBe("张三 👋 AI交流群");
  });

  it("returns whatever the server emits — local_id / ts tags preserved", async () => {
    const { runner } = fakeRunner(() => HISTORY_SAMPLE);
    __setRunner(runner);
    const out = await wechatHistory("坦丁");
    // Spike target: rich-message channels (file/image/link) keep their
    // (local_id=N, ts=T) markers so callers can later decode_*.
    expect(out).toContain("local_id=128");
    expect(out).toContain("[文件] 发票运单明细.pdf");
  });
});

describe("wechatSearch — search_messages", () => {
  it("keyword-only call uses default limit + offset", async () => {
    const { runner, calls } = fakeRunner(() => "搜索结果...");
    __setRunner(runner);
    await wechatSearch("逆变器");
    expect(calls[0]).toEqual({
      tool: "search_messages",
      args: { keyword: "逆变器", limit: 20, offset: 0 },
    });
  });

  it("passes chat_name string or array, plus time window", async () => {
    const { runner, calls } = fakeRunner(() => "");
    __setRunner(runner);
    await wechatSearch("DHL", {
      chatName: ["sean 宋 创达大哥", "Leo.yang"],
      start: "2026-05-01",
      end: "2026-06-13",
      limit: 100,
    });
    expect(calls[0]?.args).toEqual({
      keyword: "DHL",
      limit: 100,
      offset: 0,
      chat_name: ["sean 宋 创达大哥", "Leo.yang"],
      start_time: "2026-05-01",
      end_time: "2026-06-13",
    });
  });
});

describe("wechatNewMessages + wechatUnread — no longer throw", () => {
  it("wechatNewMessages now calls get_new_messages (was NotSupported under wxecho)", async () => {
    const { runner, calls } = fakeRunner(() => "新消息汇总...");
    __setRunner(runner);
    const out = await wechatNewMessages();
    expect(out).toBe("新消息汇总...");
    expect(calls).toEqual([{ tool: "get_new_messages", args: {} }]);
  });

  it("wechatUnread surfaces recent sessions w/ unread counts", async () => {
    const { runner, calls } = fakeRunner(() => SESSIONS_SAMPLE);
    __setRunner(runner);
    await wechatUnread();
    expect(calls).toEqual([{ tool: "get_recent_sessions", args: { limit: 50 } }]);
  });
});

describe("media + rich-message decoders", () => {
  it("wechatDecodeImage calls decode_image with chat_name + local_id", async () => {
    const { runner, calls } = fakeRunner(() => "/path/to/123.jpg");
    __setRunner(runner);
    const path = await wechatDecodeImage("坦丁", 128);
    expect(path).toBe("/path/to/123.jpg");
    expect(calls[0]).toEqual({
      tool: "decode_image",
      args: { chat_name: "坦丁", local_id: 128 },
    });
  });

  it("wechatDecodeFile carries create_time for cross-shard disambiguation", async () => {
    const { runner, calls } = fakeRunner(() => "");
    __setRunner(runner);
    await wechatDecodeFile("坦丁", 129, 1781329751);
    expect(calls[0]?.args).toEqual({
      chat_name: "坦丁",
      local_id: 129,
      create_time: 1781329751,
    });
  });

  it("wechatDecodeFile defaults create_time to 0 (server will reject on ambiguity)", async () => {
    const { runner, calls } = fakeRunner(() => "");
    __setRunner(runner);
    await wechatDecodeFile("坦丁", 129);
    expect(calls[0]?.args?.create_time).toBe(0);
  });
});

describe("error classification", () => {
  it("translates 'keys missing' style errors into WechatCliNotInitializedError", async () => {
    __setRunner(async () => {
      throw new Error("未找到密钥, 请运行 wxecho keys");
    });
    await expect(wechatContacts()).rejects.toBeInstanceOf(WechatCliNotInitializedError);
  });

  it("translates the English-ish 'decrypt' marker similarly", async () => {
    __setRunner(async () => {
      throw new Error("Cannot find decrypted message DB");
    });
    await expect(wechatHistory("anyone")).rejects.toBeInstanceOf(
      WechatCliNotInitializedError,
    );
  });

  it("non-init errors surface verbatim", async () => {
    __setRunner(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(wechatContacts()).rejects.toThrow("ECONNREFUSED");
  });
});

describe("WechatCliNotSupportedError — exported for back-compat", () => {
  it("is still a constructable error class (skill imports may reference it)", () => {
    const e = new WechatCliNotSupportedError("foo");
    expect(e.name).toBe("WechatCliNotSupportedError");
    expect(e.message).toContain("foo");
  });
});

describe("deprecated pure helpers — still importable for migrations in flight", () => {
  it("filterContactsText preserves header + filtered rows (legacy shape)", () => {
    const sample = `header
-----
1 line keep
2 line drop`;
    const r = filterContactsText(sample, "keep");
    expect(r).toContain("1 line keep");
    expect(r).not.toContain("2 line drop");
  });

  it("filterChatText respects start/end/limit on date-prefixed lines", () => {
    const sample = `header line
[2021-01-01 10:00:00] sender: a
[2024-08-12 09:30:00] sender: b
[2026-03-15 17:45:00] sender: c`;
    const r = filterChatText(sample, { start: "2024-01-01", limit: 1 });
    expect(r).toContain("[2026-03-15");
    expect(r).not.toContain("[2024-08-12");
    expect(r).not.toContain("[2021-01-01");
  });
});
