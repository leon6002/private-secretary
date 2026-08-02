import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deepseekJsonCaller,
  deepseekLlmCaller,
  parseDeepseekActions,
  parseDeepseekJsonObject,
} from "./llm-deepseek.js";
import type { DeepseekClient } from "../io/deepseek-api.js";

// Fake client: never touches the network — records the request so tests can
// assert on the prompt the adapter built, and returns canned model content.
function fakeClient(content: string): { client: DeepseekClient; seen: Array<{ system: string; userText: string }> } {
  const seen: Array<{ system: string; userText: string }> = [];
  const client = {
    chatJson: async (req: { system: string; userText: string }) => {
      seen.push(req);
      return content;
    },
  } as DeepseekClient;
  return { client, seen };
}

const schema = {
  type: "object",
  properties: { actions: { type: "array" } },
  required: ["actions"],
};

const draftReq = {
  system: "you are a test",
  userText: "do the thing",
  toolName: "emit_action_items",
  toolInputSchema: schema,
};

describe("parseDeepseekActions", () => {
  it("parses bare-JSON model output (the happy path)", () => {
    const content = JSON.stringify({
      actions: [{ action_type: "reply", reason: "asked for spec", confidence: 0.7, draft: "on it" }],
    });
    const actions = parseDeepseekActions(content);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action_type).toBe("reply");
  });

  it("tolerates markdown-fenced output", () => {
    const content =
      "```json\n" +
      JSON.stringify({ actions: [{ action_type: "ignore", reason: "newsletter", confidence: 0.95 }] }) +
      "\n```";
    const actions = parseDeepseekActions(content);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action_type).toBe("ignore");
  });

  it("tolerates stray prose around the JSON object", () => {
    const content = 'Here you go:\n{"actions":[{"action_type":"task","reason":"fyi","confidence":0.5}]}\nDone.';
    expect(parseDeepseekActions(content)).toHaveLength(1);
  });

  it("returns [] when the model emits no JSON object", () => {
    expect(parseDeepseekActions("I cannot help with that.")).toEqual([]);
  });

  it("returns [] when actions is missing or not an array", () => {
    expect(parseDeepseekActions('{"foo":1}')).toEqual([]);
    expect(parseDeepseekActions('{"actions":"nope"}')).toEqual([]);
  });
});

describe("parseDeepseekJsonObject", () => {
  it("parses a fenced JSON object", () => {
    expect(parseDeepseekJsonObject('```json\n{"groups":[]}\n```')).toEqual({ groups: [] });
  });

  it("throws on unparseable output", () => {
    expect(() => parseDeepseekJsonObject("no json here")).toThrow(/unparseable JSON/);
  });
});

describe("deepseekLlmCaller", () => {
  it("returns DraftedAction[] from fenced model output", async () => {
    const { client } = fakeClient(
      "```json\n" + JSON.stringify({ actions: [{ action_type: "task", reason: "r", confidence: 0.8 }] }) + "\n```",
    );
    const actions = await deepseekLlmCaller(client)(draftReq);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action_type).toBe("task");
  });

  it("returns [] when the model output has no actions array", async () => {
    const { client } = fakeClient('{"note":"nothing to do"}');
    expect(await deepseekLlmCaller(client)(draftReq)).toEqual([]);
  });

  it("embeds the tool input schema and the actions root key in the prompt", async () => {
    const { client, seen } = fakeClient('{"actions":[]}');
    await deepseekLlmCaller(client)(draftReq);
    expect(seen[0]!.system).toContain(JSON.stringify(schema));
    expect(seen[0]!.system).toContain('"actions"');
    expect(seen[0]!.system).toContain("you are a test");
    expect(seen[0]!.userText).toBe("do the thing");
  });
});

describe("deepseekLlmCaller raw-response logging", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deepseek-raw-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const logPath = () => join(dir, "llm-draft-raw.jsonl");
  // Fake client WITH a model field — the log record carries it.
  const modelledClient = (content: string): DeepseekClient =>
    ({ ...fakeClient(content).client, model: "deepseek-v4-pro" }) as DeepseekClient;

  it("empty-actions: a parsed-but-actionless response writes a record and still returns []", async () => {
    const caller = deepseekLlmCaller(modelledClient('{"note":"nothing to do"}'), { rawLogPath: logPath() });
    expect(await caller(draftReq)).toEqual([]);
    const line = JSON.parse(readFileSync(logPath(), "utf8").trim());
    expect(line.kind).toBe("empty-actions");
    expect(line.model).toBe("deepseek-v4-pro");
    expect(line.raw).toBe('{"note":"nothing to do"}');
    expect(typeof line.at).toBe("string");
  });

  it("empty-actions: an explicit empty actions array is logged too (the silent skip)", async () => {
    const caller = deepseekLlmCaller(modelledClient('{"actions":[]}'), { rawLogPath: logPath() });
    expect(await caller(draftReq)).toEqual([]);
    expect(JSON.parse(readFileSync(logPath(), "utf8").trim()).kind).toBe("empty-actions");
  });

  it("parse-failure: unparseable output writes a record and still returns []", async () => {
    const caller = deepseekLlmCaller(modelledClient("sorry, I can't do that"), { rawLogPath: logPath() });
    expect(await caller(draftReq)).toEqual([]);
    expect(JSON.parse(readFileSync(logPath(), "utf8").trim()).kind).toBe("parse-failure");
  });

  it("no rawLogPath → no file, no logging", async () => {
    const caller = deepseekLlmCaller(modelledClient("not json"), {});
    expect(await caller(draftReq)).toEqual([]);
    expect(existsSync(logPath())).toBe(false);
  });

  it("a response WITH actions writes nothing", async () => {
    const caller = deepseekLlmCaller(
      modelledClient('{"actions":[{"action_type":"task","reason":"r","confidence":0.8}]}'),
      { rawLogPath: logPath() },
    );
    expect(await caller(draftReq)).toHaveLength(1);
    expect(existsSync(logPath())).toBe(false);
  });
});

describe("deepseekJsonCaller", () => {
  it("returns the parsed object and embeds the schema in the prompt", async () => {
    const { client, seen } = fakeClient('{"groups":[{"task_id":"t1"}]}');
    const jsonSchema = { type: "object", properties: { groups: { type: "array" } } };
    const out = await deepseekJsonCaller(client)({
      system: "group things",
      userText: "cards here",
      toolInputSchema: jsonSchema,
    });
    expect(out).toEqual({ groups: [{ task_id: "t1" }] });
    expect(seen[0]!.system).toContain(JSON.stringify(jsonSchema));
  });

  it("throws when the model emits malformed JSON", async () => {
    const { client } = fakeClient("sorry, I can't do that");
    await expect(
      deepseekJsonCaller(client)({ system: "s", userText: "u", toolInputSchema: {} }),
    ).rejects.toThrow(/unparseable JSON/);
  });
});

describe("deepseekLlmCaller output budget", () => {
  it("requests 8192 max tokens — a multi-message batch truncates mid-JSON at 4096", async () => {
    const { client, seen } = fakeClient('{"actions":[]}');
    await deepseekLlmCaller(client)(draftReq);
    expect((seen[0] as { maxTokens?: number }).maxTokens).toBe(8192);
  });
});

describe("parseDeepseekActions envelope recovery", () => {
  // Real 2026-08-02 fixture: the model emitted a well-formed action object and
  // then placed "project_id" OUTSIDE it, breaking the envelope — one stray key
  // used to kill the whole draft (4 triggered messages, 0 cards).
  it("recovers intact action objects from a broken envelope", () => {
    const broken =
      '{"actions":[{"action_type":"calendar","target":{"personaKey":null,"platform":"slack"},' +
      '"reason":"meeting proposed","confidence":0.8,' +
      '"params":{"title":"迪士尼考察（下周二）","start":"2026-08-04T09:00:00+08:00","end":"2026-08-04T11:00:00+08:00"},' +
      '"draft":null,"headline":"迪士尼考察安排","summary":"对方提议下周二。","next_actions":["确认时间"]},' +
      '"project_id":"MISC"}]}';
    const actions = parseDeepseekActions(broken);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action_type).toBe("calendar");
    expect(actions[0]!.params?.title).toBe("迪士尼考察（下周二）");
  });

  it("skips objects without action_type during recovery", () => {
    const actions = parseDeepseekActions(
      '{"actions":[{"action_type":"task","reason":"r","confidence":0.7},{"note":"x"},oops]}',
    );
    expect(actions.map((a) => a.action_type)).toEqual(["task"]);
  });

  it("stops at the actions array end — a trailing action-shaped tail is not scooped", () => {
    const actions = parseDeepseekActions(
      '{"actions":[{"action_type":"task","reason":"r","confidence":0.7}],"meta":{"action_type":"relay"}',
    );
    expect(actions.map((a) => a.action_type)).toEqual(["task"]);
  });

  it("still returns [] when nothing recoverable exists", () => {
    expect(parseDeepseekActions('{"actions": []}')).toEqual([]);
    expect(parseDeepseekActions("no json here")).toEqual([]);
  });
});
