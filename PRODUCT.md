# PRODUCT.md — secretary cockpit

register: product

## What it is
A personal-secretary cockpit. The engine scans Slack and Gmail on an interval,
understands each new message with sender context, and queues suggested action
items (reply / relay / forward / calendar / task / ignore). The human reviews
each suggestion and approves, edits, or skips it; nothing sends without explicit
approval. The cockpit is the review surface for that queue.

## Who uses it
One operator triaging cross-platform messages — English-speaking Slack team plus
Chinese-speaking contacts. They are in a task, clearing a queue, not browsing.
The interface should disappear into that task: earned familiarity over novelty,
the bar is Linear / Notion / Stripe-grade trust.

## Surfaces
Three screens (post Queue+Task merge):
- Queue (home) — action-item flow with foldable task clusters; selected card
  expands in a detail pane with an inline task drill-down. The only triage surface.
- Person Profile — everything known about one contact: identity, tasks,
  commitments, provenance-tagged fields with evidence, open threads, voice notes.
- Connections — account connection management only; no behavior settings by design.

## Design language
Source of truth: DESIGN.md. White surfaces on a #F7F7F8 canvas, slate text,
one cool-blue accent (#2563EB), hairline borders, no shadows, no dark mode,
IBM Plex Sans. Light only — this is a fixed brand decision, not a default to
revisit. Calm, factual microcopy ("nothing was sent", "— not yet observed").

## Constraints
- Light theme only; the palette in DESIGN.md is committed identity.
- Cards only for the approval interaction unit; reference data uses definition
  lists / tables, never card-walls.
- Exactly two product-wide motions (approve slide-out, pending-count tick).
- personas/ and state/ hold personal data — describe role only, never display
  real contact contents in design artifacts.
