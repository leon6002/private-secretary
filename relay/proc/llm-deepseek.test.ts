import { describe, it, expect } from "vitest";
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
