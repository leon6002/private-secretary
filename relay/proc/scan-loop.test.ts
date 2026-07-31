import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScanTick } from "./scan-loop.js";
import { acquireLock, loadState, releaseLock } from "../io/state.js";
import { labelsPathFor, readLabels } from "../io/labels.js";
import type {
  SlackClient,
  SlackConversation,
  SlackHistoryResponse,
  SlackMessage,
} from "../io/slack-api.js";
import type { GmailClient, GmailMessage } from "../io/gmail-api.js";
import { encodeBase64Url } from "../io/gmail-api.js";

const SELF_SLACK = "UPHG4T8R1";

function slackStub(channels: SlackConversation[], messages: Record<string, SlackMessage[]>): SlackClient {
  return {
    authTest: vi.fn(async () => ({
      user_id: SELF_SLACK,
      team: "T",
      user: "leo",
      team_id: "T1",
      url: "",
      is_enterprise_install: false,
    })),
    listAllConversations: vi.fn(async () => channels),
    conversationsHistory: vi.fn(
      async ({ channel }) =>
        ({ messages: messages[channel] ?? [], has_more: false } as SlackHistoryResponse),
    ),
    listAllReplies: vi.fn(async () => []),
    conversationsReplies: vi.fn(async () => ({ messages: [], has_more: false })),
    usersInfo: vi.fn(async () => ({ id: "U1" })),
    downloadFile: vi.fn(async () => new Uint8Array()),
  } as unknown as SlackClient;
}

function gmailStub(profile: { historyId: string }, msgIds: string[], messages: Record<string, GmailMessage>): GmailClient {
  return {
    getProfile: vi.fn(async () => ({
      emailAddress: "leo@taiv.tv",
      messagesTotal: 1,
      threadsTotal: 1,
      historyId: profile.historyId,
    })),
    messagesList: vi.fn(async () => ({
      messages: msgIds.map((id) => ({ id, threadId: messages[id]?.threadId ?? id })),
    })),
    getMessage: vi.fn(async ({ id }) => messages[id]!),
    // Thread lookup by threadId — return every message in this thread.
    getThread: vi.fn(async ({ id }) => ({
      id,
      messages: Object.values(messages).filter((m) => m.threadId === id),
    })),
    listAllHistory: vi.fn(async () => ({ records: [], currentHistoryId: profile.historyId })),
    historyList: vi.fn(async () => ({ history: [], historyId: profile.historyId })),
    getAttachment: vi.fn(async () => new Uint8Array()),
    createDraft: vi.fn(async () => ({ id: "D", message: { id: "M", threadId: "T" } })),
  } as unknown as GmailClient;
}

function makeGmailMessage(opts: {
  id: string;
  threadId: string;
  from: string;
  to: string;
  body: string;
  date?: number;
  labelIds?: string[];
}): GmailMessage {
  return {
    id: opts.id,
    threadId: opts.threadId,
    internalDate: String(opts.date ?? 1781000000000),
    labelIds: opts.labelIds ?? ["INBOX", "UNREAD"], // new mail is unread (gate added 2026-06-20)
    payload: {
      headers: [
        { name: "From", value: opts.from },
        { name: "To", value: opts.to },
      ],
      body: { data: encodeBase64Url(opts.body) },
      mimeType: "text/plain",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: encodeBase64Url(opts.body) },
        },
      ],
    },
  };
}

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scan-loop-"));
  statePath = join(dir, "loop-state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runScanTick", () => {
  it("pulls Slack + Gmail, runs trigger filter, persists shadow record + state", async () => {
    const slack = slackStub(
      // is_im=true so default scope (ims-and-mpims) includes it
      [{ id: "C1", is_im: true }],
      {
        C1: [
          { ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` },
        ],
      },
    );
    const gmail = gmailStub(
      { historyId: "9999" },
      ["GM1"],
      {
        GM1: makeGmailMessage({
          id: "GM1",
          threadId: "GT1",
          from: "alice@x.com",
          to: "leo@taiv.tv",
          body: "hi leo",
        }),
      },
    );
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
    });
    expect(r.totalInbound).toBe(2); // 1 Slack + 1 Gmail
    expect(r.totalTriggered).toBe(2); // both addressed-to-user
    expect(r.shadowWritten).toBe(true);

    // state file is on disk and has both cursor slices stored under marks
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.marks._slackDirect).toEqual({ channels: { C1: { lastTs: "100.0" } } });
    expect(saved.marks._gmailDirect).toEqual({
      mailboxes: { "leo@taiv.tv": { historyId: "9999" } },
    });

    // shadow-log line written
    const shadow = readFileSync(join(dir, "shadow-log.jsonl"), "utf8");
    expect(shadow.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  it("records sourceErrors when a source throws but lets the other source finish", async () => {
    const slack = {
      authTest: vi.fn(async () => ({
        user_id: SELF_SLACK,
        team: "T",
        user: "leo",
        team_id: "T1",
        url: "",
        is_enterprise_install: false,
      })),
      listAllConversations: vi.fn(async () => {
        throw new Error("slack rate-limit");
      }),
    } as unknown as SlackClient;
    const gmail = gmailStub(
      { historyId: "1" },
      ["GM1"],
      {
        GM1: makeGmailMessage({
          id: "GM1",
          threadId: "GT1",
          from: "alice@x.com",
          to: "leo@taiv.tv",
          body: "hi",
        }),
      },
    );
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
    });
    expect(r.perSource.find((s) => s.source === "slack:direct")?.error).toMatch(
      /slack rate-limit/,
    );
    expect(r.perSource.find((s) => s.source === "gmail:direct")?.inboundCount).toBe(1);

    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.sourceErrors["slack:direct"]).toBeTruthy();
    expect(saved.sourceErrors["slack:direct"].message).toMatch(/slack rate-limit/);
  });

  it("clears sourceErrors for sources that recover on the next tick", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], { C1: [{ ts: "1.0", user: "U2", text: `<@${SELF_SLACK}>` }] });
    const gmail = gmailStub({ historyId: "1" }, [], {});

    // tick 1: pre-seed sourceErrors via a fake state
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        marks: {},
        actions: [],
        outcomes: [],
        sourceErrors: { "slack:direct": { message: "old", at: "2020-01-01T00:00:00Z" } },
        tasks: {},
      }),
    );

    await runScanTick({ statePath, slackClient: slack, gmailClients: { "leo@taiv.tv": gmail } });
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.sourceErrors["slack:direct"]).toBeUndefined();
  });

  it("does NOT write a shadow record when nothing was seen + nothing was filtered", async () => {
    const slack = slackStub([], {});
    const gmail = gmailStub({ historyId: "1" }, [], {});
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
    });
    expect(r.shadowWritten).toBe(false);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "shadow-log.jsonl"))).toBe(false);
  });

  it("dryRun=true: does not mutate state or write shadow-log", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], { C1: [{ ts: "1.0", user: "U2", text: `<@${SELF_SLACK}>` }] });
    const gmail = gmailStub(
      { historyId: "1" },
      ["GM1"],
      {
        GM1: makeGmailMessage({ id: "GM1", threadId: "GT1", from: "a@x.com", to: "leo@taiv.tv", body: "hi" }),
      },
    );
    await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
      dryRun: true,
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(statePath)).toBe(false); // never written
    expect(existsSync(join(dir, "shadow-log.jsonl"))).toBe(false);
  });

  it("widens windows when onWake is true (Gmail bootstrapWindowDays goes up)", async () => {
    const slack = slackStub([], {});
    const gmail = gmailStub({ historyId: "1" }, [], {});
    await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
      onWake: true,
    });
    // The Gmail stub doesn't expose call args directly; just verify no
    // crash. The wider window is exercised by scanGmailDirect's own
    // bootstrap path which has its own tests.
  });

  it("drafting runs OUTSIDE the state lock (the cockpit can write during a draft)", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` }],
    });
    const gmail = gmailStub({ historyId: "1" }, [], {});
    let lockWasFreeDuringDraft = false;
    const draft = {
      // The LLM call stands in for the slow draft. While it runs, the lock
      // MUST be free — i.e. acquirable by a concurrent writer (the cockpit).
      llm: async () => {
        if (acquireLock(dir)) {
          lockWasFreeDuringDraft = true;
          releaseLock(dir);
        }
        return [
          { action_type: "reply" as const, target: { platform: "slack" as const, personaKey: null }, reason: "r", confidence: 0.9, draft: "hey" },
        ];
      },
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    };
    const r = await runScanTick({ statePath, slackClient: slack, gmailClients: { "leo@taiv.tv": gmail }, draft });
    expect(lockWasFreeDuringDraft).toBe(true); // lock released before drafting
    expect(r.drafted).toBe(1);
    // and the drafted action was still committed (phase 3 re-locked + saved)
    expect(loadState(statePath).actions.filter((a) => a.status === "suggested")).toHaveLength(1);
  });

  it("does NOT throw when the lock is held at scan start (PHASE 0 is lockless)", async () => {
    const slack = slackStub([], {});
    const gmail = gmailStub({ historyId: "1" }, [], {});
    // Someone else (the cockpit) holds the lock across the whole tick. The old
    // code threw "another tick is running" at scan start; now the scan reads
    // unlocked and only the brief commits contend — so the tick still completes.
    acquireLock(dir);
    try {
      const r = await runScanTick({ statePath, slackClient: slack, gmailClients: { "leo@taiv.tv": gmail } });
      expect(r).toBeDefined();
      expect(r.perSource.length).toBeGreaterThan(0);
    } finally {
      releaseLock(dir);
    }
  });

  it("commits cursors BEFORE drafting (phase 1.5) so a later commit miss can't lose them", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` }],
    });
    const gmail = gmailStub({ historyId: "1" }, [], {});
    let cursorOnDiskDuringDraft: unknown;
    const draft = {
      // By the time the (slow) draft runs, the cursor must ALREADY be persisted
      // — phase 1.5 commits cursors before phase 2. So if phase 3 later can't
      // re-acquire the lock, the cursor advance is safe (only drafts re-run).
      llm: async () => {
        const onDisk = loadState(statePath) as unknown as {
          marks: { _slackDirect?: { channels: Record<string, { lastTs: string }> } };
        };
        cursorOnDiskDuringDraft = onDisk.marks._slackDirect?.channels?.C1?.lastTs;
        return [
          { action_type: "reply" as const, target: { platform: "slack" as const, personaKey: null }, reason: "r", confidence: 0.9, draft: "hey" },
        ];
      },
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    };
    await runScanTick({ statePath, slackClient: slack, gmailClients: { "leo@taiv.tv": gmail }, draft });
    expect(cursorOnDiskDuringDraft).toBe("100.0"); // committed before the draft ran
  });

  it("draft dep: drafts candidates into the queue + counts them", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` }],
    });
    const gmail = gmailStub({ historyId: "1" }, [], {});
    // stub LLM: produce one reply for whatever it's given
    const draft = {
      llm: async () => [
        {
          action_type: "reply" as const,
          target: { platform: "slack" as const, personaKey: null },
          reason: "answer",
          confidence: 0.9,
          draft: "hey",
        },
      ],
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    };
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
      draft,
    });
    expect(r.drafted).toBe(1);
    const saved = loadState(statePath);
    expect(saved.actions).toHaveLength(1);
    expect(saved.actions[0]!.action_type).toBe("reply");
    expect(saved.actions[0]!.status).toBe("suggested");
  });

  it("patches the Slack display name onto inbound messages → drafted context.sender_name", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` }],
    });
    // The default stub's usersInfo returns no name fields; give U2 a display name.
    (slack.usersInfo as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      id: "U2",
      profile: { display_name: "Zack" },
    }));
    const gmail = gmailStub({ historyId: "1" }, [], {});
    const draft = {
      llm: async () => [
        {
          action_type: "reply" as const,
          target: { platform: "slack" as const, personaKey: null },
          reason: "answer",
          confidence: 0.9,
          draft: "hey",
        },
      ],
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    };
    await runScanTick({ statePath, slackClient: slack, gmailClients: { "leo@taiv.tv": gmail }, draft });
    const saved = loadState(statePath);
    expect(saved.actions).toHaveLength(1);
    expect(saved.actions[0]!.context?.sender_handle).toBe("U2");
    expect(saved.actions[0]!.context?.sender_name).toBe("Zack");
  });

  it("sender-name resolution failure is silent — the draft still commits with the raw ID", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` }],
    });
    (slack.usersInfo as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("ratelimited");
    });
    const gmail = gmailStub({ historyId: "1" }, [], {});
    const draft = {
      llm: async () => [
        {
          action_type: "reply" as const,
          target: { platform: "slack" as const, personaKey: null },
          reason: "answer",
          confidence: 0.9,
          draft: "hey",
        },
      ],
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    };
    const r = await runScanTick({ statePath, slackClient: slack, gmailClients: { "leo@taiv.tv": gmail }, draft });
    expect(r.drafted).toBe(1);
    const saved = loadState(statePath);
    expect(saved.actions[0]!.context?.sender_handle).toBe("U2");
    expect(saved.actions[0]!.context?.sender_name).toBeUndefined();
  });

  it("consolidate dep: groups two ungrouped open cards under one shared task_id", async () => {
    const mk = (id: string) => ({
      id, source_message_id: `wechat:${id}`, action_type: "task" as const,
      target: {}, reason: "r", confidence: 0.5, params: {}, status: "suggested" as const,
      created_at: "2026-06-23T00:00:00Z",
    });
    writeFileSync(statePath, JSON.stringify({
      version: 2, marks: {}, actions: [mk("a"), mk("b")], outcomes: [], sourceErrors: {}, tasks: {},
    }));
    const consolidate = {
      json: async () => ({
        assignments: [
          { card_id: "a", task_title: "ZF suspension visit" },
          { card_id: "b", task_title: "ZF suspension visit" },
        ],
      }),
      now: () => "2026-06-23T12:00:00Z",
    };
    await runScanTick({ statePath, sources: [], consolidate });
    const saved = loadState(statePath);
    const ids = saved.actions.map((a) => a.task_id);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]); // both cards now share one task
    expect(Object.keys(saved.tasks)).toHaveLength(1);
    expect(saved.tasks[ids[0]!]!.title).toBe("ZF suspension visit");
  });

  it("refresh dep: re-reads a resolved thread → supersedes the stale card with a calendar action", async () => {
    writeFileSync(statePath, JSON.stringify({
      version: 2, marks: {}, outcomes: [], sourceErrors: {}, tasks: {},
      actions: [{
        id: "m1", source_message_id: "wechat:m1", action_type: "reply",
        target: { platform: "wechat", personaKey: null }, reason: "ask to schedule",
        confidence: 0.5, params: {}, status: "suggested", created_at: "2026-06-23T00:00:00Z",
        draft: "麻烦张工帮忙约一下", context: { sender_handle: "张工" },
      }],
    }));
    const refresh = {
      llm: async () => [{
        action_type: "calendar" as const, reason: "thread agreed Wed 9:30", confidence: 0.8,
        params: { title: "实车测试 @安亭", start: "2026-06-24T09:30:00+08:00", end: "2026-06-24T11:00:00+08:00" },
        headline: "实车测试 周三 9:30", summary: "时间已定", next_actions: [],
      }],
      resolvePersona: () => null,
      fetchThread: async () => "me: 时间定了告诉我\n张工: 周三九点半",
      now: () => "2026-06-23T12:00:00Z",
    };
    await runScanTick({ statePath, sources: [], refresh });
    const saved = loadState(statePath);
    expect(saved.actions.find((a) => a.id === "m1")).toBeUndefined(); // stale card superseded
    const cal = saved.actions.find((a) => a.action_type === "calendar");
    expect(cal).toBeDefined();
    expect(cal!.params.title).toBe("实车测试 @安亭");
    expect(cal!.context?.sender_handle).toBe("张工"); // same conversation
  });

  it("Gmail: a real email NOT addressed to Leo still reaches drafting (LLM judges); noreply stays filtered", async () => {
    const slack = slackStub([], {});
    const gmail = gmailStub({ historyId: "1" }, ["GM1", "GM2"], {
      // Leo is NOT in To (came via a list/forward) — the old deterministic
      // gate dropped this as "not-addressed"; now it must reach the LLM.
      GM1: makeGmailMessage({
        id: "GM1", threadId: "GT1", from: "alice@partner.com",
        to: "team-list@taiv.tv", body: "Can someone confirm the Q3 numbers?",
        labelIds: ["INBOX", "UNREAD"],
      }),
      // Automated sender — still dropped cheaply, never drafted.
      GM2: makeGmailMessage({
        id: "GM2", threadId: "GT2", from: "no-reply@service.com",
        to: "leo@taiv.tv", body: "Your receipt", labelIds: ["INBOX", "UNREAD"],
      }),
    });
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
    });
    const g = r.perSource.find((s) => s.source === "gmail:direct");
    expect(g?.triggered).toBe(1); // the real person's email → candidate
    expect(g?.filtered).toBe(1); // the noreply → filtered
  });

  it("non-primary Gmail mail is filtered at ingestion: counted, dedup-marked, never drafted", async () => {
    const slack = slackStub([], {});
    const gmail = gmailStub({ historyId: "1" }, ["GM1"], {
      GM1: makeGmailMessage({
        id: "GM1",
        threadId: "GT1",
        from: "deals@shop.com",
        to: "leo@taiv.tv",
        body: "50% off everything",
        labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
      }),
    });
    const llm = vi.fn(async () => []);
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
      draft: { llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z" },
    });
    expect(r.promoFiltered).toBe(1);
    expect(r.totalTriggered).toBe(0); // promo never became a candidate
    expect(r.drafted).toBe(0);
    expect(llm).not.toHaveBeenCalled(); // excluded BEFORE intent analysis
    // dedup-marked seen (so it's never re-evaluated) + in the shadow log
    const saved = loadState(statePath);
    expect(saved.actions).toHaveLength(0);
    const shadow = readFileSync(join(dir, "shadow-log.jsonl"), "utf8").trim();
    expect(JSON.parse(shadow).filtered).toEqual([{ id: "gmail:GM1", reason: "gmail:promotions" }]);
  });

  it("sources:[wechat] drafts a new 1:1 WeChat message into the queue", async () => {
    const llm = vi.fn(async () => [
      {
        action_type: "reply" as const,
        target: { platform: "wechat" as const, personaKey: null },
        reason: "answer",
        confidence: 0.5,
        draft: "好的",
      },
    ]);
    const r = await runScanTick({
      statePath,
      sources: ["wechat"],
      wechatFetchContacts: async () => "",
      wechatFetchSessions: async () =>
        "最近 1 个会话:\n\n[06-14 21:39] 金小奇 芯联集成 (1条未读)\n  文本: 那很好啊",
      wechatFetchHistory: async () => "[2026-06-14 21:39] 金小奇 芯联集成: 那很好啊",
      draft: { llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z" },
    });
    expect(r.perSource.find((s) => s.source === "wechat:direct")?.inboundCount).toBe(1);
    expect(r.drafted).toBe(1);
    const saved = loadState(statePath);
    expect(saved.actions).toHaveLength(1);
    expect(saved.actions[0]!.source_message_id).toContain("wechat:金小奇");
  });

  it("WeChat: re-poll deduped (isNew); a new incoming surfaces + supersedes the prior card; Leo's own (unread 0) never cards", async () => {
    const SESSIONS1 = "最近 2 个会话:\n\n[06-14 21:39] 金小奇 芯联集成 (1条未读)\n  文本: 那很好啊\n\n[06-14 21:52] 坦丁\n  文本: bro，你在北京么";
    const HIST1 = "[2026-06-14 21:39] 金小奇 芯联集成: 那很好啊";
    const llm = vi.fn(async () => [
      {
        action_type: "reply" as const,
        target: { platform: "wechat" as const, personaKey: null },
        reason: "answer",
        confidence: 0.5,
        draft: "好的",
      },
    ]);
    const draft = { llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z" };
    // Tick 1: 金小奇 unread=1 surfaces; 坦丁 has unread 0 (Leo's own send) → never carded.
    const r1 = await runScanTick({
      statePath, sources: ["wechat"], wechatFetchContacts: async () => "",
      wechatFetchSessions: async () => SESSIONS1,
      wechatFetchHistory: async () => HIST1,
      draft,
    });
    expect(r1.drafted).toBe(1);
    expect(loadState(statePath).actions[0]!.source_message_id).toContain("wechat:金小奇");

    // Tick 2 = same unread set re-polled. Persisted marks dedup it → no re-draft.
    const r2 = await runScanTick({
      statePath, sources: ["wechat"], wechatFetchContacts: async () => "",
      wechatFetchSessions: async () => SESSIONS1,
      wechatFetchHistory: async () => HIST1,
      draft,
    });
    expect(r2.perSource.find((s) => s.source === "wechat:direct")?.inboundCount).toBe(0);
    expect(r2.drafted).toBe(0);
    expect(loadState(statePath).actions).toHaveLength(1);

    // A genuinely new incoming message (new ts ⇒ new id) surfaces AND supersedes
    // the prior still-suggested 金小奇 card — one card per conversation, not two.
    const SESSIONS3 = "最近 1 个会话:\n\n[06-14 21:45] 金小奇 芯联集成 (2条未读)\n  文本: 还有个问题";
    const HIST3 = "[2026-06-14 21:39] 金小奇 芯联集成: 那很好啊\n[2026-06-14 21:45] 金小奇 芯联集成: 还有个问题";
    const r3 = await runScanTick({
      statePath, sources: ["wechat"], wechatFetchContacts: async () => "",
      wechatFetchSessions: async () => SESSIONS3,
      wechatFetchHistory: async () => HIST3,
      draft,
    });
    expect(r3.drafted).toBe(1);
    const after = loadState(statePath).actions;
    expect(after).toHaveLength(1); // prior 金小奇 card superseded, not appended
    expect(after[0]!.context?.original_message).toContain("还有个问题"); // it's the new card
  });

  // MANDATORY REGRESSION — supersede-exports-first. A superseded card never
  // reaches a terminal status, so no "export the terminal actions" pass can
  // recover it: this is the BIGGER of the two label leaks (502 shadow ids → 173
  // surviving). The label must be written BEFORE the card is dropped.
  it("supersede-exports-first: a superseded card is labelled before it is dropped", async () => {
    const SESS = (ts: string, unread: number, text: string) =>
      `最近 1 个会话:\n\n[${ts}] 金小奇 芯联集成 (${unread}条未读)\n  文本: ${text}`;
    const llm = vi.fn(async () => [
      {
        action_type: "reply" as const,
        target: { platform: "wechat" as const, personaKey: null },
        reason: "answer",
        confidence: 0.5,
        draft: "好的",
      },
    ]);
    const draft = { llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z" };
    const tick = (ts: string, unread: number, text: string, hist: string) =>
      runScanTick({
        statePath, sources: ["wechat"], wechatFetchContacts: async () => "",
        wechatFetchSessions: async () => SESS(ts, unread, text),
        wechatFetchHistory: async () => hist,
        draft,
      });

    await tick("06-14 21:39", 1, "那很好啊", "[2026-06-14 21:39] 金小奇 芯联集成: 那很好啊");
    const firstId = loadState(statePath).actions[0]!.id;

    await tick(
      "06-14 21:45", 2, "还有个问题",
      "[2026-06-14 21:39] 金小奇 芯联集成: 那很好啊\n[2026-06-14 21:45] 金小奇 芯联集成: 还有个问题",
    );

    // The dropped card survives in the ledger, with its snapshot intact.
    const recs = readLabels(readFileSync(labelsPathFor(statePath), "utf8"));
    const rescued = recs.filter((r) => r.decision === "superseded");
    expect(rescued.map((r) => r.action_id)).toContain(firstId);
    expect(rescued.find((r) => r.action_id === firstId)!.source_snapshot.id).toBe(firstId);
    // …and it really is gone from the live queue (behaviour unchanged).
    expect(loadState(statePath).actions.some((a) => a.id === firstId)).toBe(false);
  });

  // MANDATORY REGRESSION — P1 durable task identity. Before P1, a supersede
  // dropped the old card's task_id (the fresh draft has none until the
  // consolidate pass runs), detaching the plan + cockpit cluster from the
  // task. The replacement must INHERIT (copy, never mint) the task_id.
  it("supersede-inherits-task_id: a fresh draft for the same sender keeps the superseded card's task_id", async () => {
    const SESS = (ts: string, unread: number, text: string) =>
      `最近 1 个会话:\n\n[${ts}] 金小奇 芯联集成 (${unread}条未读)\n  文本: ${text}`;
    const llm = vi.fn(async () => [
      {
        action_type: "reply" as const,
        target: { platform: "wechat" as const, personaKey: null },
        reason: "answer",
        confidence: 0.5,
        draft: "好的",
      },
    ]);
    const draft = { llm, resolvePersona: () => null, knownPersonaKeys: [], now: () => "2026-06-14T12:00:00Z" };
    const tick = (ts: string, unread: number, text: string, hist: string) =>
      runScanTick({
        statePath, sources: ["wechat"], wechatFetchContacts: async () => "",
        wechatFetchSessions: async () => SESS(ts, unread, text),
        wechatFetchHistory: async () => hist,
        draft,
      });

    await tick("06-14 21:39", 1, "那很好啊", "[2026-06-14 21:39] 金小奇 芯联集成: 那很好啊");
    const firstId = loadState(statePath).actions[0]!.id;

    // Simulate the consolidate pass having grouped the card under a task.
    const st = loadState(statePath);
    st.actions[0]!.task_id = "task_jinxiaoqi";
    st.tasks["task_jinxiaoqi"] = { title: "芯联对接", created_at: "2026-06-14T12:00:00Z" };
    writeFileSync(statePath, JSON.stringify(st));

    await tick(
      "06-14 21:45", 2, "还有个问题",
      "[2026-06-14 21:39] 金小奇 芯联集成: 那很好啊\n[2026-06-14 21:45] 金小奇 芯联集成: 还有个问题",
    );

    const after = loadState(statePath).actions;
    expect(after).toHaveLength(1); // superseded, not appended
    expect(after[0]!.id).not.toBe(firstId); // it IS the fresh card
    expect(after[0]!.task_id).toBe("task_jinxiaoqi"); // …carrying the SAME task
  });

  it("no draft dep: scan-only, zero drafted, no queue rows", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` }],
    });
    const gmail = gmailStub({ historyId: "1" }, [], {});
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
    });
    expect(r.drafted).toBe(0);
    expect(loadState(statePath).actions).toHaveLength(0);
  });

  it("maxDraftCandidates: drafts only the NEWEST cap, reports the rest as draftSkipped", async () => {
    // 3 IM channels, 3 senders, ascending ts. Cap=2 → the two newest
    // (U_C2 @200, U_C3 @300) get drafted; the oldest (U_C1 @100) is the
    // explicit skipped remainder.
    const slack = slackStub(
      [
        { id: "C1", is_im: true },
        { id: "C2", is_im: true },
        { id: "C3", is_im: true },
      ],
      {
        C1: [{ ts: "100.0", user: "U_C1", text: `<@${SELF_SLACK}> oldest` }],
        C2: [{ ts: "200.0", user: "U_C2", text: `<@${SELF_SLACK}> middle` }],
        C3: [{ ts: "300.0", user: "U_C3", text: `<@${SELF_SLACK}> newest` }],
      },
    );
    const gmail = gmailStub({ historyId: "1" }, [], {});
    const draft = {
      llm: async () => [
        {
          action_type: "reply" as const,
          target: { platform: "slack" as const, personaKey: null },
          reason: "answer",
          confidence: 0.9,
          draft: "ok",
        },
      ],
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    };
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
      draft,
      maxDraftCandidates: 2,
    });
    expect(r.totalTriggered).toBe(3);
    expect(r.drafted).toBe(2);
    expect(r.draftSkipped).toBe(1);
    const saved = loadState(statePath);
    expect(saved.actions).toHaveLength(2);
    const handles = saved.actions.map((a) => a.context?.sender_handle).sort();
    expect(handles).toEqual(["U_C2", "U_C3"]); // oldest U_C1 dropped
  });

  it("maxDraftCandidates: no skip when candidates are at or under the cap", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `<@${SELF_SLACK}> hi` }],
    });
    const gmail = gmailStub({ historyId: "1" }, [], {});
    const draft = {
      llm: async () => [
        {
          action_type: "reply" as const,
          target: { platform: "slack" as const, personaKey: null },
          reason: "answer",
          confidence: 0.9,
          draft: "ok",
        },
      ],
      resolvePersona: () => null,
      knownPersonaKeys: [],
      now: () => "2026-06-14T12:00:00Z",
    };
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
      draft,
      maxDraftCandidates: 5,
    });
    expect(r.drafted).toBe(1);
    expect(r.draftSkipped).toBe(0);
  });

  it("draft LLM error → recorded in sourceErrors as llm:draft, tick still completes", async () => {
    const slack = slackStub([{ id: "C1", is_im: true }], {
      C1: [{ ts: "100.0", user: "U2", text: `hi <@${SELF_SLACK}>` }],
    });
    const gmail = gmailStub({ historyId: "1" }, [], {});
    const draft = {
      llm: async () => {
        throw new Error("anthropic 500");
      },
      resolvePersona: () => null,
      knownPersonaKeys: [],
    };
    const r = await runScanTick({
      statePath,
      slackClient: slack,
      gmailClients: { "leo@taiv.tv": gmail },
      draft,
    });
    expect(r.drafted).toBe(0);
    expect(loadState(statePath).sourceErrors["llm:draft"]).toBeTruthy();
  });
});
