import { describe, it, expect } from "vitest";
import { parsePersona, PersonaParseError } from "./personas.js";

const legacy = {
  key: "wang-acme",
  display_name: "王总",
  relationship: "external customer",
  handles: { wechat: "wxid_wz8821", gmail: "wang@acme.com", slack: null },
  language: "zh",
  register: "formal",
  tone_notes: "concise",
  context: "Acme rollout",
};

const v3 = {
  key: "michael-dobosz",
  display_name: "Michael Dobosz",
  identity: {
    role: "Embedded Systems Team Lead (hardware & firmware)",
    org: "Taiv",
    relationship: "Leo's direct lead",
  },
  handles: { slack: "UR36HT3HV", gmail: "michael@taiv.tv", wechat: null },
  communication: { language: "en", register: "casual", tone_notes: "brief, rapid-fire" },
  open_threads: "power-supply sizing",
  provenance: { "identity.*": "manual" },
  style_profile_meta: { last_built_at: null },
};

describe("parsePersona (legacy v2 layout)", () => {
  it("parses a valid persona and drops null handles", () => {
    const p = parsePersona(legacy);
    expect(p.key).toBe("wang-acme");
    expect(p.language).toBe("zh");
    expect(p.handles).toEqual({ wechat: "wxid_wz8821", gmail: "wang@acme.com" });
  });

  it("throws on a missing required field", () => {
    const bad = { ...legacy } as Record<string, unknown>;
    delete bad.key;
    expect(() => parsePersona(bad)).toThrow(PersonaParseError);
  });

  it("throws on an invalid language", () => {
    expect(() => parsePersona({ ...legacy, language: "fr" })).toThrow(/language must be/);
  });

  it("throws on an invalid register", () => {
    expect(() => parsePersona({ ...legacy, register: "shouty" })).toThrow(/register must be/);
  });

  it("throws on a non-mapping", () => {
    expect(() => parsePersona("nope")).toThrow(PersonaParseError);
  });
});

describe("parsePersona (v3 hierarchical layout)", () => {
  it("maps v3 paths onto the flat pipeline shape", () => {
    const p = parsePersona(v3);
    expect(p.key).toBe("michael-dobosz");
    expect(p.language).toBe("en");
    expect(p.register).toBe("casual");
    expect(p.toneNotes).toBe("brief, rapid-fire");
    expect(p.context).toBe("power-supply sizing");
    expect(p.handles).toEqual({ slack: "UR36HT3HV", gmail: "michael@taiv.tv" });
    expect(p.relationship).toContain("Embedded Systems Team Lead");
    expect(p.relationship).toContain("Leo's direct lead");
  });

  it("requires communication.language/register on v3 files", () => {
    const bad = { ...v3, communication: { tone_notes: "x" } };
    expect(() => parsePersona(bad)).toThrow(/communication.language/);
  });

  it("v3 detection: identity/communication/provenance blocks switch the parser", () => {
    // legacy file with none of the v3 blocks goes down the legacy path even
    // if sparse; a v3 file missing communication fails loudly, not silently.
    expect(parsePersona(legacy).context).toBe("Acme rollout");
    expect(() =>
      parsePersona({ key: "x", display_name: "X", identity: { role: "r" } }),
    ).toThrow(PersonaParseError);
  });
});
