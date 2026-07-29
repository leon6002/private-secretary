// Stage 1 ANCHORS — the frozen contract for the Stage 0–6 redesign
// (PROJECT_CONTEXT.md §4, specs/anchor-pipeline.md). An anchor is a literal,
// verifiable hook extracted from ONE sender's messages. Association (Stage 2) is
// built ONLY from these explicit anchors — never from model semantic intuition —
// so "wrong-link" hallucination is structurally impossible past a verifiable
// extraction error. This module is the deterministic VALIDATOR (the safety net
// that exists before Stage 1's LLM extraction): it drops any anchor whose
// `verbatim` isn't a real source substring, and rejects malformed `resolvable_id`s.
// Pure — no I/O.

export type AnchorType = "person" | "org_project" | "reference" | "deadline" | "obligation";
export type RefKind = "jira" | "notion" | "url" | "quoted_reply" | "prior_thread";

export interface Anchor {
  type: AnchorType;
  verbatim: string; // literal source substring; the validator drops the anchor if this isn't a substring
  value: string; // normalized: person→persona key / org→canonical name / deadline→ISO
  ref_kind?: RefKind; // reference only
  resolvable_id?: string; // PROJ-123 / url / thread_ts if resolvable, else ""
  directed_at_leo?: boolean; // obligation only
  ask_span?: string; // obligation only — verbatim of the request sentence
}

export interface MessageAnchors {
  message_id: string;
  anchors: Anchor[];
}

export interface SenderAnchors {
  sender_key: string;
  platform: "slack" | "gmail" | "wechat";
  messages: MessageAnchors[];
}

export const ANCHOR_TYPES: ReadonlySet<string> = new Set<AnchorType>([
  "person",
  "org_project",
  "reference",
  "deadline",
  "obligation",
]);
export const REF_KINDS: ReadonlySet<string> = new Set<RefKind>([
  "jira",
  "notion",
  "url",
  "quoted_reply",
  "prior_thread",
]);

// resolvable_id format per ref_kind. jira/url/notion have strict shapes (a fabricated
// id that doesn't match is rejected). quoted_reply/prior_thread carry a platform
// thread locator (slack ts / gmail hex id) whose shape varies — accept any
// non-whitespace token, reject only whitespace/garbage.
const JIRA_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const NOTION_RE = /^(?:https?:\/\/(?:www\.)?notion\.so\/\S+|[0-9a-f]{32}|[0-9a-f-]{36})$/i;
const THREAD_RE = /^\S+$/;

export function resolvableIdValid(refKind: RefKind, id: string): boolean {
  switch (refKind) {
    case "jira":
      return JIRA_RE.test(id);
    case "url":
      return URL_RE.test(id);
    case "notion":
      return NOTION_RE.test(id);
    case "quoted_reply":
    case "prior_thread":
      return THREAD_RE.test(id);
  }
}

// Validate ONE anchor against its source text. Returns a list of problems (empty =
// valid). The caller drops any anchor with a non-empty result. This is the hard
// guarantee: no anchor survives whose `verbatim` isn't literally in the source.
export function validateAnchor(a: Anchor, sourceText: string): string[] {
  const errs: string[] = [];
  if (!ANCHOR_TYPES.has(a.type)) errs.push(`unknown type: ${a.type}`);
  if (typeof a.verbatim !== "string" || a.verbatim.length === 0) {
    errs.push("verbatim empty");
  } else if (!sourceText.includes(a.verbatim)) {
    errs.push(`verbatim not a source substring: ${JSON.stringify(a.verbatim.slice(0, 40))}`);
  }
  if (typeof a.value !== "string" || a.value.length === 0) errs.push("value empty (normalized value required)");

  if (a.type === "reference") {
    if (!a.ref_kind || !REF_KINDS.has(a.ref_kind)) {
      errs.push(`reference needs a valid ref_kind (got ${a.ref_kind ?? "none"})`);
    } else if (a.resolvable_id && a.resolvable_id.length > 0 && !resolvableIdValid(a.ref_kind, a.resolvable_id)) {
      errs.push(`resolvable_id ${JSON.stringify(a.resolvable_id)} invalid for ref_kind ${a.ref_kind}`);
    }
  }
  if (a.type === "obligation" && typeof a.ask_span === "string" && a.ask_span.length > 0) {
    if (!sourceText.includes(a.ask_span)) errs.push("ask_span not a source substring");
  }
  return errs;
}

export interface DroppedAnchor {
  message_id: string;
  anchor: Anchor;
  errors: string[];
}

// Filter a sender's anchors against the per-message source text, dropping any that
// fail validation. Returns the cleaned SenderAnchors + the dropped anchors (with
// reasons) for observability + tests. `sourceById` maps message_id → its raw text.
export function filterValidAnchors(
  sender: SenderAnchors,
  sourceById: Record<string, string>,
): { clean: SenderAnchors; dropped: DroppedAnchor[] } {
  const dropped: DroppedAnchor[] = [];
  const messages = sender.messages.map((m) => {
    const src = sourceById[m.message_id] ?? "";
    const anchors = m.anchors.filter((a) => {
      const errs = validateAnchor(a, src);
      if (errs.length > 0) {
        dropped.push({ message_id: m.message_id, anchor: a, errors: errs });
        return false;
      }
      return true;
    });
    return { message_id: m.message_id, anchors };
  });
  return { clean: { ...sender, messages }, dropped };
}
