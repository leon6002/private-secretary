# Anchor pipeline — frozen contract (Stage 0–6 redesign)

Source of truth: `PROJECT_CONTEXT.md` §4 (2026-07-12). This file freezes the Stage-1
**Anchor** contract + the 5 type-boundary definitions that every downstream stage
consumes. Implemented in `relay/core/anchors.ts`; enforced by `relay/core/anchors.test.ts`.

## Core principle (§4.2, [已定])
Association is established ONLY by **explicit anchors**, never by a model's semantic
intuition. "What is related" = a mechanical, verifiable operation (Stage 2). "What to
do about it" = the only part handed to the LLM (Stage 5). No RAG / agentic-memory for
relatedness — RAG is a similarity engine that hallucinates "related". Precision over
recall: **错连(wrong-link)必须趋近 0;漏连只是少便利。**

## Anchor schema (frozen — all downstream consumes this)
```jsonc
{
  "sender_key": "string",
  "platform": "slack | gmail | wechat",
  "messages": [{
    "message_id": "string",
    "anchors": [{
      "type": "person | org_project | reference | deadline | obligation",
      "verbatim": "string",        // literal source substring; validator drops the anchor if not a substring
      "value": "string",           // normalized: person→persona key / org→canonical / deadline→ISO
      "ref_kind": "jira | notion | url | quoted_reply | prior_thread", // reference only
      "resolvable_id": "string",   // PROJ-123 / url / thread_ts if resolvable, else ""
      "directed_at_leo": true,     // obligation only
      "ask_span": "string"         // obligation only — verbatim of the request sentence
    }]
  }]
}
```

## 5 type-boundary definitions (each: 1 positive / 1 negative)

1. **person** — a NAMED individual mappable to a persona. Generic references don't count.
   - ✅ "ask **Sarah** to review" → person, value=persona key for Sarah.
   - ❌ "someone on the team should look" → NOT an anchor (no named, mappable person).

2. **org_project** — a NAMED company / project / product. Unnamed "the vendor" doesn't count.
   - ✅ "the **Renesas** deal is stuck" → org_project, value="Renesas" (canonical).
   - ❌ "that other supplier pulled out" → NOT an anchor (unnamed).

3. **reference** — an EXPLICIT reference: `re:` / a quoted reply / a Jira key / a URL.
   Vague back-references don't count.
   - ✅ "see **PROJ-142**" → reference, ref_kind=jira, resolvable_id="PROJ-142".
   - ❌ "like I mentioned earlier" → NOT an anchor (no explicit locator).

4. **deadline** — an EXPLICIT time. "asap / 尽快" is a weak signal only, not a deadline anchor.
   - ✅ "need it **by Friday 5pm**" → deadline, value=ISO datetime.
   - ❌ "please do this soon" → NOT a deadline anchor.

5. **obligation** — a request/question DIRECTED AT the user. Pure statements or already-answered
   items don't count.
   - ✅ "**can you send the signed contract?**" → obligation, directed_at_leo=true, ask_span=that sentence.
   - ❌ "fyi we shipped it yesterday" → NOT an obligation (no ask of the user).

## Deterministic validator (safety net, exists BEFORE Stage 1)
`validate(anchor, source_text) → errors[]`:
1. `verbatim` MUST be a non-empty substring of `source_text` — else the anchor is dropped.
2. `value` MUST be non-empty (a normalized value is required).
3. `reference`: `ref_kind` required; if `resolvable_id` is non-empty it MUST match the
   format for its `ref_kind` (jira `ABC-123`, url `http(s)://…`, notion id/url, thread ts).
   A fabricated id that fails its format is rejected (mandatory regression test).
4. `obligation`: `ask_span`, when present, MUST also be a substring of `source_text`.
Batch-in reference resolution is allowed (Stage 1); inventing entities NOT in the batch is not.
