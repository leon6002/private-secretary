# Spec proposal: Persona v3 → behavior enhancement (delta)

## Status: PROPOSAL — not yet approved. Reviews against `specs/persona-v3.md`.

Borrows three things from the `titanwings/colleague-skill` methodology (the
same lineage our Style pass + `reference-tags.md` already came from), adapted to
OUR use case. NOT a full adoption — see §0.

## 0. Use-case framing (why we take some, drop most)

`colleague-skill` builds a profile to **impersonate** a person — generate text
*as them*, in *their* voice, via "Layer 0 hard rules" + a separate `work.md`.

Our secretary does the opposite end: it (1) reads the intent of messages a
contact sends Leo, and (2) drafts Leo's reply **in Leo's voice**
(`leo-anti-ai-response`), matching register to the recipient and avoiding their
landmines. So:

- Adopt: the **behavioral dimensions** our Style pass already extracts (decision
  / interpersonal / boundaries-landmines) — they sharpen intent-reading and
  register/landmine-aware drafting.
- Adopt: a **correction layer** for human feedback on behavior.
- Adopt: a **materiality threshold** to keep inferences honest.
- Drop: persona/work split, Layer-0 "speak-as-them" rules, enterprise-culture-
  as-identity (we already carry culture as evidenced tags).

What is NOT changing: provenance + evidence + R1 (already stronger than
colleague-skill), staged/promote gate, anti-fabrication prompt, the two-phase
bootstrap, sparse-is-correct.

## A. Structured `behavior` sub-schema (the main change)

**Problem today.** The bootstrap Style pass (SKILL.md §5.3) already extracts
decision-pattern, interpersonal, and boundaries/landmines dimensions — but the
v3 schema has no slots for them, so SKILL.md tells the analyzer to "fold the
findings into existing string fields." We do the extraction work and then lose
the structure. Drafting can't reliably consult "how does this person say no" or
"what are their landmines" because it's buried in free prose.

**Change.** Give those dimensions dedicated optional slots under `behavior`.
Every leaf stays inferred-only, evidence-required, omit-if-empty (v3 rules
unchanged). The block stays sparse — most contacts fill few of these.

```yaml
behavior:
  # ── existing v3 fields (unchanged) ──
  reliability: string?
  bad_news_style: string?
  pet_peeves: [string]?

  # ── NEW: decision pattern (from threads/reviews/choices) ──
  decision:
    priorities: string?         # efficiency | process | data | people | resources | politics
    push_triggers: string?      # what gets them to move something forward
    stall_triggers: string?     # what makes them stall / hand off / quietly ignore
    disagreement_style: string? # flat no | probing questions | silence | redirect
    under_fire: string?         # response to "this is broken on your side"
    uncertainty_stance: string? # admit | hedge | hand off

  # ── NEW: interpersonal (context-dependent behavior) ──
  interpersonal:
    with_superiors: string?
    with_reports: string?
    with_peers: string?
    under_pressure: string?     # what specifically changes when pushed / blamed

  # ── NEW: boundaries & landmines (the drafting-critical part) ──
  landmines:
    pushes_back_on: [string]?
    hard_lines: [string]?
    avoids: [string]?           # topics they sidestep
    says_no_by: string?         # flat refusal | excuse | silence | forward to someone

  # ── NEW: evidenced pattern tags (reference-tags.md vocabulary) ──
  work_style_tags: [string]?    # e.g. ["只读不回", "完美主义"] — ≤3, each evidenced
  culture_tags: [string]?       # e.g. ["字节范"] — ≤2, each evidenced
```

- Nesting is shallow (one level) and every sub-block is omitted whole when empty
  — same "空块直接省略" rule as v3.
- Provenance + evidence use the existing dotted-path map; nested paths fit with
  no mechanism change: `behavior.decision.disagreement_style: inferred`, evidence
  keyed under the same path. Wildcards (`behavior.decision.*`) still work.
- `work_style_tags` / `culture_tags` replace the SKILL.md note that currently
  shoves tags into prose. Now they have a real home; `reference-tags.md` becomes
  the controlled vocabulary for these two arrays (still: no evidence → no tag).

## B. Correction layer (structured human feedback)

**Problem today.** When the user corrects the secretary's read of a person
("he wouldn't reply that fast — he ghosts until you chase him"), the only place
that lands is a hand-edited field flipped to `manual`. That loses the
*situational* shape of the correction and doesn't compound.

**Change.** Add a top-level `corrections` ledger — scene/wrong/correct triplets,
always provenance `manual` (human-stated), consulted at draft time.

```yaml
corrections:                    # R1-manual always; human-stated, never LLM-written
  - scene: string               # "when Leo asks him for an ETA"
    wrong: string               # what a draft/read got wrong
    correct: string             # what's actually true of this person
    at: timestamp
```

Rules:
- **Write path is human-only.** The LLM never writes `corrections` (it is outside
  the persona-write `llm` mode's allowed paths — same chokepoint as R1). Populated
  by an explicit user action: a new `relay persona-correct <key>` CLI (minimal),
  or a future cockpit People-screen field. NOT auto-mined from edits in v1.
- **Consulted at draft time.** `draft-prompt.ts` surfaces matching corrections
  to the analyzer ("known corrections for this contact: …") so a repeated
  mistake is not repeated.
- **Cap + merge.** Soft cap ~30 per contact; when exceeded, the user is asked to
  merge semantically similar ones (no silent drop). Deferred until any contact
  actually approaches the cap.

This is the persisted form of the same feedback loop Phase B already owns; it
does not add an auto-update path and does not touch R1.

## C. Materiality threshold (anti-fabrication tightening)

**Problem today.** v3 requires "evidence exists" but not *how much*. A single
offhand line can mint a confident behavioral trait.

**Change.** A behavioral inference (`behavior.decision.*`,
`behavior.interpersonal.*`, `behavior.landmines.*`, `*_tags`) requires **≥2
corroborating messages** to be asserted.

- With exactly 1 signal: **omit** by default (sparse is correct).
- Exception — **landmines**: a single clear signal of a hard line / pet peeve MAY
  be kept (safety-relevant: better to over-avoid), but flagged. The evidence entry
  carries a `low_evidence` note so review can see it rests on one message.
- Does NOT apply to factual fields (identity, handles, commitments,
  open_threads) — those keep the existing one-good-source rule.

## Schema / code impact (when implemented — not now)

Purely additive; existing personas validate unchanged (new fields simply
absent). Migration of michael-dobosz.yaml etc. is a no-op.

- `relay/core/persona-v3.ts` — add the optional nested `behavior.*`,
  `corrections[]` fields to the schema/validator. No field becomes required.
- `relay/io/persona-store.ts` — `corrections` added to the manual-only path set
  (LLM writes to it are dropped, like any `manual` field under R1). Materiality
  (C) is a bootstrap-prompt rule, not a store rule — the store can't count
  source messages, so it stays a generation-side guard verified at review.
- `.claude/skills/persona-bootstrap/SKILL.md` — Style pass renders findings into
  the new structured slots instead of prose; add the ≥2-source rule to the
  anti-fabrication prompt; point tag emission at `behavior.work_style_tags` /
  `culture_tags`.
- `relay/proc/draft-prompt.ts` — `describePersona()` surfaces `landmines` +
  `corrections` so drafts avoid known traps.
- New CLI `relay persona-correct <key>` (B's write path) — small, mirrors
  `persona-write`'s manual mode.

## Definition of Done (for the eventual implementation)

- A bootstrapped persona with rich history fills `behavior.decision` /
  `interpersonal` / `landmines` as structured fields, each path evidenced, none
  guessed; a contact with thin history fills none of them (sparse).
- A `behavior.*` inference backed by only 1 message is omitted (or, for a
  landmine, present with `low_evidence`).
- `relay persona-correct` writes a `corrections` entry that survives a forced
  LLM rebuild (R1) and shows up in the next draft's context.
- Existing personas validate with zero changes; michael-dobosz migration output
  is byte-identical to the v3 spec example.
- A draft to a "只读不回 / says_no_by: silence" contact comes out tight with an
  explicit ask (landmine consulted), not open-ended.

## Open questions for review

1. **Nesting vs flat.** Shallow nesting (`behavior.decision.push_triggers`) reads
   cleanly but adds schema surface. Alternative: flat keys
   (`behavior.decision_push_triggers`). Nesting recommended; flag if you'd rather
   stay flat to minimize the validator diff.
2. **Corrections write path.** CLI-only in v1 (recommended, minimal), or wait and
   wire it into the cockpit People screen directly?
3. **Should this be a new `persona-v4.md` spec, or an in-place revision of
   `persona-v3.md`?** It's additive, so an in-place "v3.1" amendment section may
   be cleaner than a new file — your call.
