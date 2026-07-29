# Phase 2 Cockpit — Stitch designs (source of truth for the UI)

Pulled from Google Stitch project "Relay Cockpit Inbox"
(`projects/4924454636315865000`) on 2026-06-12 via the stitch MCP. These three
HTML files are the visual source of truth for Phase 2 implementation. All
functionality and product-flow logic follows these.

## The app is THREE screens (user decision 2026-06-12)

Task View is DROPPED as a top-level screen. Task context still lives INSIDE the
Queue (task clusters in the master list + the task drill-down / sub-actions in
the selected-card detail). Top-level nav = exactly three:

| # | Screen | File | Nav icon |
|---|--------|------|----------|
| 1 | Queue (master-detail approval) | `queue.html` | `inbox` / `queue` |
| 2 | People → Person Profile | `person-profile.html` | `group` |
| 3 | Connections (settings) | `connections.html` | `hub` |

Every screen keeps the same persistent 56px left rail switching among these
three. (Person Profile's contact switcher becomes a SECOND column, not the
global rail.)

## Canonical design tokens (from queue.html + DESIGN.md — these win)

- Type: **IBM Plex Sans** (Latin) + **IBM Plex Sans SC** (中文). NOT Inter.
- Primary accent: **`#2563EB`**. Canvas `#F7F7F8`. Surface `#FFFFFF`.
  Hairline border `#E5E7EB`. Slate text `#1A1D21` / `#64748b`.
- Error/soft-red `#EF4444`. Task-cluster band `#F1F2F4`.
- Radius 6px cards/buttons, 4px chips, 11px status pills. No shadows.
- Action-type tags: reply blue, relay purple, forward teal, calendar green,
  task gray, brief slate. Amber RESERVED for needs-info. Violet for staged
  banner. Slack `#4A154B`, Gmail `#EA4335`, WeChat green/forum.
- Language badge: `EN | 中文` text chips, never flags.

## Reconciliation deltas to apply during implementation (NOT yet done in Stitch)

1. **Unify the left rail on all three screens** to the same 3-item global nav
   (Queue / People / Connections). Specifically:
   - Connections: remove the 4th "Tasks" (`task_alt`) item.
   - Person Profile: replace the contact-avatar rail with the 3-item global
     rail; move the contact switcher to a slim second column inside People.
   - Standardize active-state color to primary `#2563EB` (Connections currently
     uses secondary indigo `#4648d4`) and the Queue icon (`inbox` vs `queue`).
2. **Re-theme Person Profile** from the old Stitch system (Inter, emerald
   `#006948`, bg `#f9f9ff`) to the canonical IBM Plex / `#2563EB` / `#F7F7F8`
   tokens above. Its structure (provenance lock/I badges, click evidence
   popover, tasks-with-person, commitments They Owe/I Owe, open threads, voice
   & style, staged-rebuild banner) is correct — only the theme changes.
3. Person Profile uses fake demo data (Alexander Voss / Acme / Berlin). Wire to
   real persona v3 fields (provenance/evidence/commitments/open_threads).

## What each screen already gets right (keep)

- Queue: master-detail; task clusters; all five card states (needs-info amber,
  awaiting-manual Copy→Mark sent, ready/selected, brief slate Acknowledge &
  archive, send-failure red Retry); routing line; reasoning + evidence chips;
  EN|中文 badge; sub-actions checklist with AI/Me attribution; context shelf.
- Person Profile: provenance manual(lock)/inferred(I) badges; click-to-open
  evidence popover (quote + date + platform + view source); tasks-with-person;
  commitments ledger; open threads; voice & style; staged-rebuild banner with
  Review diff / Promote.
- Connections: 3-section sparse layout; per-source cards w/ status dot +
  detection-mode chip + scope line; Gmail draft-only note; empty-slot connect
  cards; "How it works" read-only card; mobile bottom-nav variant.
