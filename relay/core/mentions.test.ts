import { describe, it, expect } from "vitest";
import { personaAliases, detectMentions } from "./mentions.js";
import type { Persona } from "./types.js";

function persona(key: string, displayName: string): Persona {
  return {
    key, displayName, relationship: "", handles: {}, language: "zh",
    register: "casual", toneNotes: "", context: "",
  } as Persona;
}

const jin = persona("wechat-qh-jin", "金小奇 芯联集成");
const chen = persona("wechat-chen", "陈古龙");
const mitch = persona("mitch-conway", "Mitch Conway");
const all = [jin, chen, mitch];

describe("personaAliases", () => {
  it("yields full name, first token, and the X总 honorific for a CJK name", () => {
    expect(personaAliases(jin)).toEqual(expect.arrayContaining(["金小奇 芯联集成", "金小奇", "金总"]));
  });
  it("yields the first name for a latin name (no 总 form)", () => {
    expect(personaAliases(mitch)).toEqual(expect.arrayContaining(["Mitch Conway", "Mitch"]));
    expect(personaAliases(mitch)).not.toContain("M总");
  });
});

describe("detectMentions", () => {
  it("finds a third party referenced as 'X总' and excludes the sender", () => {
    const text = "那就看金总了，你俩协商一下到哪个地铁站";
    expect(detectMentions(text, all, { excludeKey: "wechat-chen" })).toEqual(["wechat-qh-jin"]);
  });
  it("finds by full name too", () => {
    expect(detectMentions("金小奇开车带咱们", all, { excludeKey: "wechat-chen" })).toContain("wechat-qh-jin");
  });
  it("returns nothing when no known contact is named", () => {
    expect(detectMentions("明天去开会", all)).toEqual([]);
  });
  it("caps at limit", () => {
    const text = "金总 陈古龙 Mitch 都来";
    expect(detectMentions(text, all, { limit: 2 }).length).toBe(2);
  });
});
