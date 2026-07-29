# Phase 2 Cockpit — Design Plan (3 screens, task-based)

Status: DESIGN-REVIEWED (/plan-design-review 2026-06-11) + STITCH DESIGNS LANDED
(2026-06-12). The implemented visual source of truth is now
`specs/phase2-stitch/` (queue.html, person-profile.html, connections.html) +
its README. This plan's IA/states/journey still govern behavior.

**3-screen update (user decision 2026-06-12):** the app is THREE top-level
screens — Queue / People (Person Profile) / Connections. **Task View is dropped
as a standalone screen**; task context lives inside the Queue (task clusters +
selected-card task drill-down). Persistent 56px left rail switches among the
three on every screen. Canonical tokens = IBM Plex Sans/SC + `#2563EB` (see
specs/phase2-stitch/README.md); the Person-Profile Stitch screen drifted to
Inter/emerald and must be re-themed during build.

Product unit = TASK (user decision 2026-06-11, supersedes "unit = RELAY").
The four Stitch prompts at the bottom are FINAL copy-paste sources — every
review decision is already baked in. Shared tokens live in DESIGN.md.
Engine prerequisite (separate PR): task entity + ActionItem.task_id.

## Information Architecture (decided 2026-06-11, Pass 1)

```
┌─────┬──────────────────────────────────────────────────────┐
│ NAV │  QUEUE (home)          master-detail                 │
│  ▣  │ ┌─────────────┐ ┌──────────────────────────────────┐ │
│Queue│ │ task group A │ │  SELECTED CARD (expanded)        │ │
│  ◻  │ │  ▸card ▸card │ │  routing line / original full /  │ │
│Tasks│ │ task group B │ │  attachments / evidence / draft  │ │
│  ◻  │ │  ▸card       │ │  / approve·edit·skip             │ │
│People│ │ ungrouped…  │ └──────────────────────────────────┘ │
│  ◻  │ └─────────────┘                                      │
│Conn │   compact rows; selected = anchor                    │
└─────┴──────────────────────────────────────────────────────┘
```

1. **1A Global nav**: persistent slim left rail (Queue/Tasks/People/Connections,
   pending badge, wordmark on top) in ALL four prompts.
2. **2A Queue = master-detail**: left compact list grouped by task; right pane =
   selected card expanded. Selected card is the page's visual anchor.
3. **3A Person Profile = two columns**: WORK (tasks, commitments) left;
   REFERENCE (provenance definition list — NOT cards, threads, voice) right.
   Evidence opens on CLICK; mockup shows one popover open.
4. **4A Approval lives ONLY in Queue**: Task View shows inert gray "pending in
   Queue" timeline entries that deep-link back.
5. **5A Ordering**: groups oldest-first; within a group ready-first,
   needs-info last. Headline: "8 pending across 3 tasks".
6. Task View context shelf collapsible. 7. Group headers STRUCTURAL
   (full-width tinted band), not slim.

## Interaction States (decided 2026-06-11, Pass 2)

| FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL |
|---|---|---|---|---|---|
| Queue | first sync: 3 skeleton cards + "Reading sources…" | **6A THE SUCCESS STATE**: quiet "All handled." + auto-handled drawer centered + last-scan time | slim banner per failed source: "Slack unreachable — cursor frozen, nothing lost" | **7A** approve → card slides out, count ticks | one source down, rest renders + banner |
| Card draft | — | — | send-failure: card STAYS, soft red "Send failed — nothing was sent", [Retry] primary | slack slide-out; gmail/wechat morph to AWAITING MANUAL | "edited" badge |
| Task View | two-pane skeleton | "No open tasks — the queue is clear too." | inline retry | — | waiting-on IS partial |
| Person Profile | skeleton | sparse = FEATURE: "— not yet observed" gray, never fake data | load failure | staged banner | per-field staged diff |
| Connections | OAuth: spinner + "authorization window opened" | first run: guided connect | token expired soft red | green dot | some accounts down |
| Avatars | — | initials circle, hue hashed from key; never stock faces | — | — | — |

**8A Recourse**: auto-handled drawer lists EVERY assistant-solo decision;
every row [Restore to queue] (restore records negative outcome → Phase B
learning). Skipped cards land in the drawer under "Skipped".

## User Journey (decided 2026-06-11, Pass 3)

| STEP | USER DOES | FEELS | SUPPORT |
|---|---|---|---|
| 0 | first run, nothing connected | curiosity | Connections-first guided connect |
| 1 | opens Queue | "it understood" | task groups, "8 pending across 3 tasks" |
| 2 | j/k through cards, verifies routing first | control | master-detail anchor, ready-first |
| 3 | approves | done-ness | slide-out + tick (the only 2 motions) |
| 4 | edits when needed | precision | **10A** read-only draft → [Edit] → "edited" badge → diff feeds gate |
| 5 | manual legs | never doubts | **11A** explicit [Copy]→[Mark sent], one at a time; Gmail deep-link |
| 6 | scans drawer | growing trust | every solo decision + [Restore] |
| 7 | reaches zero | reward | 6A quiet proof |

**12A Motion budget**: exactly two motions product-wide.

## Slop Defenses + Design System (Pass 4+5)

**13A** `EN` / `中文` text badges, never flags · **14A** amber = needs-info
ONLY, brief = slate, staged = soft violet · **15A** wordmark: lowercase
"secretary" (placeholder) · **16C** confidence hidden ≥0.8, warning chip
below · **17A** IBM Plex Sans + IBM Plex Sans SC, slate neutrals, #2563EB
accent, hairline borders, NO shadows, 8px grid → full preamble in DESIGN.md.

## Responsive + Accessibility (Pass 6)

**18A** Desktop-first BY DECLARATION (1280px+). Mobile approval view =
Phase 2.5 TODO; master-detail collapses without rework.
**19A** Keyboard triage: `j/k` cards, `a` approve, `e` edit, `s` skip,
`u` undo skip, `g`+`t/p/c` screens, `?` sheet. Focus = 2px accent outline.
a11y: body ≥13.5px @ ≥4.5:1, targets ≥44px, popover keyboard-openable,
nav = ARIA landmark.

## Final Decisions (Pass 7)

**20A** validation chip stays until the gate passes, then retires.
**21A** Overflow: task titles 2-line ellipsis + tooltip; list-draft 4-line
fade (full text in detail pane); avatars max 3 + "+N".

---

# FINAL STITCH PROMPTS (paste in order: Queue → Task View → Profile → Connections)

## Shared preamble (already embedded in each prompt below)

See DESIGN.md "Design system preamble". Each prompt below begins with it.

## Screen 1: Queue (home)

```
DESIGN SYSTEM (identical across all screens of this app):
- Product wordmark: "secretary" lowercase, top of the left nav rail.
- Typography: IBM Plex Sans for Latin; IBM Plex Sans SC for Chinese — same
  family, bilingual text must look like one voice. Type scale: 22px page
  title / 15px section heading / 13.5px body / 12px meta. Body line-height 1.6.
- Color: white surfaces on #F7F7F8 canvas; slate text (#1A1D21 / #6B7280);
  hairline borders #E5E7EB — NO drop shadows anywhere; structure from borders
  and background tint zoning.
- One accent: cool blue #2563EB (primary buttons, selected states).
- Action-type tags (muted): reply blue, relay purple, forward teal, calendar
  green, task gray, brief slate. Amber RESERVED for needs-info only.
- Spacing: 8px grid; dense 8/12px inside cards, generous 24/32px between groups.
- Radius 6px (cards/buttons), 4px (chips). Avatars: no photo → initials on a
  hue-hashed circle, never stock faces. Language badges: text chips EN / 中文.
- Banned: gradients, icons-in-circles, centered text blocks, border-left accent
  stripes, blobs/waves, emoji as UI, dark mode, shadows, Inter/Roboto/system-ui.

Design a desktop web app screen (1280px+): the "Queue" home page of a
personal-secretary cockpit. Calm, trustworthy, information-dense rows with
generous group spacing.

SHELL: persistent slim left nav rail (56px): wordmark "secretary" on top, then
icons Queue (active, with pending-count badge "8") / Tasks / People /
Connections. Top bar: page headline "8 pending across 3 tasks", a quiet
"last sync 2 min ago · event-driven" indicator, a small "12/20 clean" chip.

LAYOUT — MASTER-DETAIL:
LEFT (~380px): compact card list grouped by TASK. Group headers are
STRUCTURAL full-width tinted bands (#F1F2F4): task title (2-line ellipsis),
involved-people initials avatars (max 3 + "+N"), "2 of 4 done", collapse
control. Groups oldest-first; within a group ready-to-approve cards first,
needs-info last. Ungrouped standalone cards at the same level. Each compact
row: action-type tag, sender → recipient mini routing, first line of draft
(4-line max fade), state tint. Selected row: 2px accent outline.

RIGHT (the visual anchor): the SELECTED card expanded:
- ROUTING LINE on top: sender avatar+platform icon → recipient avatar+platform
  icon, action-type tag. The thing the user verifies first.
- ORIGINAL MESSAGE: full quoted text, attachment thumbnails inline.
- WHY: one reasoning line + small "evidence consulted" chips. NO confidence
  meter — only if confidence is low show a chip "low confidence · 0.6".
- DRAFT: READ-ONLY chat-bubble text block with language badge (EN or 中文 —
  text chip, no flags). An [Edit] secondary button switches it to an editable
  textarea and adds an "edited" badge.
- ACTIONS row: primary [Approve & Send] (#2563EB), secondary [Edit],
  low-emphasis text [Skip]. Keyboard hints beside: a / e / s.

SHOW THESE STATES across the visible cards:
- one NEEDS-INFO card (amber tint, primary disabled, missing field as inline
  fillable chip "meeting time?") — calm, not an error;
- one AWAITING-MANUAL WeChat card: explicit [Copy] button, then [Mark sent]
  (disabled until copied); a Gmail variant: "Draft created — [Open Gmail]";
- one BRIEF card (slate tag): single line "Khadas PO: vendor confirmed the
  missing $1,500, nothing needed from you." + one button [Acknowledge & archive];
- one SEND-FAILURE state: card with soft red banner "Send failed — nothing was
  sent" + [Retry] primary.

BOTTOM of left list: collapsed drawer "Auto-handled (6) · Skipped (2)" — rows
each with a [Restore to queue] ghost button.

DO NOT include: chat compose, settings toggles, dark mode, bulk-select,
notification bells, percentage rings. English UI text with 中文 inside one
draft bubble to show bilingual rendering.
```

## Screen 2: (dropped — Task View is not a standalone screen)

Task View was removed from the app (user decision 2026-06-12). Task context now
lives INSIDE the Queue: task clusters in the master list (`groupByTask`) + the
selected-card task drill-down (sub-actions checklist + context shelf, already in
queue.html). The top-level nav is three items — Queue / People / Connections.
No separate Task-View prompt; do not regenerate one.

## Screen 3: Person Profile

```
[SAME DESIGN SYSTEM BLOCK AS ABOVE — paste verbatim]

Design a desktop web app screen (1280px+): the "Person Profile" page of the
same personal-secretary cockpit. Same left nav rail (People active) plus a
slim contact-switcher column of initials avatars.

IDENTITY HEADER across the top: large display name, chips: role @ org,
relationship ("Leo's direct lead"), language badge (EN / 中文 text chip),
register (casual/formal), timezone with live local time, platform handle
icons (Slack, Gmail, WeChat) with connected/missing states, small power
indicator (serves-them / peer / leads-them).

BELOW THE HEADER — TWO COLUMNS:

WORK COLUMN (left, wider — this is what the user came for):
1. TASKS WITH THIS PERSON: rows with task title, status pill, sub-action
   state icons, other people involved (mini avatars). Primary block.
2. COMMITMENTS LEDGER: two-column table "They owe" / "I owe": what, due,
   status (open / done / overdue subtle red), source-message link. Example:
   "Follow up with the master's student — September".

REFERENCE COLUMN (right, narrower):
3. PROFILE FIELDS as a DEFINITION LIST (label: value rows — NOT cards). Every
   value carries a tiny provenance badge: "manual" (solid lock) or "inferred"
   (dotted outline). ONE EVIDENCE POPOVER SHOWN OPEN in the mockup, anchored
   to an inferred field (opens on CLICK): one-line source quote, date,
   platform icon, "view source" link. Empty fields render as quiet gray
   "— not yet observed" (sparse profiles are correct, never fake data).
4. OPEN THREADS: short bullets, each with an evidence link.
5. VOICE & STYLE: collapsible quiet card — how they write / how I write to them.

CONDITIONAL BANNER (show it): soft VIOLET band across the top: "Staged rebuild
awaiting review — manual fields will be preserved" with [Review diff] and
[Promote] buttons.

DO NOT include: settings, toggles, chat windows, auto-send controls, photo
avatars, dark mode. English UI text; one field value in 中文.
```

## Screen 4: Connections

```
[SAME DESIGN SYSTEM BLOCK AS ABOVE — paste verbatim]

Design a desktop web app screen (1280px+): the "Connections" page of the same
personal-secretary cockpit. Same left nav rail (Connections active).
Deliberately SPARSE — this app has no behavior settings by design.

Single centered column (~720px):

1. CONNECTED SOURCES — one row-card per account:
   - Slack · Taiv workspace: green dot "connected", @LeoZheng, chip
     "real-time · Socket Mode", last event time, [Reconnect] ghost.
   - Gmail · leo@taiv.tv: green, "delta check every 2 min", quiet note
     "sending is draft-only by design — you press Send in Gmail", [Reconnect].
   - Gmail · empty slot: [+ Connect another Gmail].
   - Slack · empty slot: [+ Connect workspace].
   - WeChat: gray "manual" — "read/send handled manually for now", no button.
   - Google Calendar: green, connected.
   - ONE ERROR EXAMPLE: soft red card "token expired — cursor frozen, nothing
     lost" with [Reconnect] primary.
   - ONE IN-FLIGHT EXAMPLE: spinner + "authorization window opened".
   Each connected card: small scope line (read · draft · send-where-applicable).

2. HOW IT WORKS (read-only info card, no controls):
   "Nothing is ever sent without your approval." /
   "Behavior rules are fixed by design — there are no toggles." /
   "Detection is event-based; analysis runs only when something arrives."

3. DANGER ZONE: [Disconnect] per account only.

FIRST-RUN note: if nothing is connected, this page is where the app lands,
with the first empty-slot card highlighted.

DO NOT include: notification prefs, interval sliders, auto-send rules, model
pickers, theme switcher, dark mode. English UI text.
```

## NOT in scope (considered, deferred with rationale)

- Mobile approval view → Phase 2.5 (18A; master-detail collapses cleanly).
- Dark mode → excluded by design across all prompts.
- Bulk-select / batch approve → single-card keyboard flow covers the speed
  need without batch-risk (wrong-recipient is the worst failure mode).
- Achievement-style stats on empty state → rejected (6B), conflicts with calm.
- Mockup generation via gstack designer → user generates via Stitch.

## What already exists (reuse, don't reinvent)

- Phase 1 card semantics: 批准并发送/编辑/跳过, needs-info, awaiting-manual,
  brief cards, auto-handled drawer — validated in chat, carried over 1:1.
- persona v3 data model (provenance/evidence/commitments) — drives Profile.
- Engine truth for every state: execution_receipt → send states; sourceErrors
  → source banners; gate outcomes → edited badge; loop-state queue → list.
- DESIGN.md (new this review) — the single token source.

## Implementation Tasks

Design review + Phase 2 eng review (2026-06-12). jq unavailable → this list is
canonical. Order follows the sequencing decision below.

Design-review carryovers:
- [x] WeChat explicit-copy flow (done in-review)
- [ ] Mobile approval view — Phase 2.5 (TODOS.md)

Phase 2 (P2-0 core → P2-1 cockpit render → P2-2 wire actions):
- [x] **T1 (P1)** relay/core — lightweight task model: `task_id?` on ActionItem +
  `tasks` registry in loop-state; `groupByTask` (tasks.ts); round-commit assigns;
  progress derived. Regression test green (round-commit without task_id unchanged).
  + skill round-commit now assigns task_id + tasks map.
- [x] **T2 (P1)** relay/core — `ActionContext` persisted on ActionItem at scan time
  (original_message, sender, permalink, attachments, evidence_consulted); skill
  populates it. Cockpit renders the detail pane offline.
- [x] **T3 (P1)** relay/core — `queue` now returns `pendingExecution` (approved
  auto-send items queued to flush) + grouped `clusters`. (was cli.ts:218)
- [x] **T4 (P1)** relay/core — `markExecuting`/`isExecuting` + `executing`
  transition: claim before the MCP call; skill verifies-on-retry, never
  blind-resends. Critical gap closed.
- [x] **T5 (P1)** relay/io — atomic state writes (temp+rename) + stale-lock
  reclaim (mtime). (persona-store lock still TODO — see below.)
- [x] **T6 (P2)** relay/core — `restoreAction` + `restore` transition
  (rejected/approved → suggested, blocked once a receipt exists).
- [ ] **T7 (P1)** cockpit — thin local server importing relay/core (reuse lock +
  persona-store), 3-screen shell (IBM Plex/#2563EB), renders Queue master-detail
  + Person Profile + Connections from loop-state + personas; triage-only
  (approve/edit/skip via core); polls loop-state for live updates. **NEXT.**
- [ ] **T8 (P1)** cockpit — security baseline: loopback-only bind, CSRF/origin
  check, restrictive file perms (serves private message content). [Codex]
- [x] **T9 (P2)** specs — reconciled this file to 3 screens (Task View screen
  removed; nav = Queue/People/Connections).
- [ ] **T10 (P3)** relay/core — cross-round task-identity hardening: stable
  task_id + merge/reassign so the LLM can't spawn duplicate tasks. [Codex]
- [ ] **T5b (P2)** relay/io — bring persona-store writes under a lock (T5 covered
  state.ts atomicity + stale-lock; persona writes are still unlocked). [Codex persona-store.ts:98]

## Engineering Review — Phase 2 (2026-06-12)

Load-bearing decisions:
1. **Sequence, don't big-bang.** T1 core → cockpit-over-files (Claude Code stays
   the runtime) → wire actions. Standalone Claude-API runtime + multi-account
   mcp_servers + Socket Mode + Gmail send → Phase 3, gated on the cockpit
   proving useful. Spends 1 innovation token, not 3.
2. **Cockpit is triage-only** (no MCP). Approve sets `status=approved` via
   relay/core; the real Slack-send / Gmail-draft flushes when the user runs a
   Claude Code /relay pass. "Approve & Send" → "Approve" + "queued — run /relay".
3. **Cockpit writes through relay/core + the existing lock; never raw JSON.**
   Imports core directly (typed, dodges the Windows stdin/BOM trap); personas via
   the persona-store R1 chokepoint.
4. **Lightweight task model** (task_id + registry, derived progress), not a Task
   state machine.
5. **All 3 screens now** (user override of Codex's queue-only argument — Person
   Profile earns it for reviewing the freshly bootstrapped personas).
6. **Persist message + evidence on ActionItem at scan time** so the detail pane
   renders offline; pairs with the T8 loopback/file-perms baseline.

NOT in scope (deferred):
- Standalone Claude-API runtime + multi-account mcp_servers → Phase 3 (only
  needed for unattended op; gate not cleared).
- Slack Socket Mode + Gmail history event detection → Phase 3 (30-min poll stays).
- Real Gmail send path → Phase 3 (stays draft-only).
- Mobile cockpit → Phase 2.5.
- loop-state pruning/archival → TODO (unbounded growth, not yet a problem).
- Full cross-round task-merge UI → T10, after the basic model proves out.

Failure modes (new codepaths):
- Crash between MCP-send and receipt persist → **duplicate send** → T4. **Critical
  gap until T4 lands** (currently silent-ish).
- Cockpit reads loop-state mid-write → truncated JSON → T5 (transient render
  error, retryable, no data loss until then).
- Stale lock after crash → all writes blocked → T5 (manual `.lock` delete until
  then).
- LLM mints duplicate task_ids → T10 (visible as duplicate clusters, not silent).

Parallelization:
- **Lane A (sequential, shared action-item.ts/cli.ts):** T1 → T2 → T3 → T4 → T6.
- **Lane B (relay/io, light overlap on state.ts — coordinate):** T5.
- **Lane C (cockpit/, new dir):** T7+T8 shell/render can start in parallel; the
  approve-wiring half of T7 depends on Lane A landing.
- T9 (specs) anytime. Order: A + C-shell in parallel, B alongside A; merge A;
  then C-wiring.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR (2026-06-10) | 6 proposals, 0 accepted, 6 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES (this run) | ~14 findings; 6 folded P1/P2, 4 deferred, 2 cross-model decided by user |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR (PLAN, this run) | 6 decisions, 10 tasks, 1 critical gap (T4) |
| Design Review | `/plan-design-review` | UI/UX gaps | 2 | CLEAR (FULL, 2026-06-11) | score: 6/10 → 9/10, 21 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** independent pass found the split-brain truth (no flush queue,
  approved conflates states, receipt race), concurrency gaps (non-atomic writes,
  stale lock, unlocked persona writes), and the detail-pane data gap. 6 folded as
  P1/P2 tasks (T2-T6,T8), 4 deferred (T10 + NOT-in-scope), 2 surfaced as
  cross-model tensions and decided by the user (all-3-screens; persist content).
- **CROSS-MODEL:** Codex's strategic "queue-only until the gate passes" was
  presented; user chose all-3-screens with full context (reviewing bootstrapped
  personas). Codex's idempotency finding overturned the review's "handled" claim
  → T4.
- **VERDICT:** ENG (PLAN) CLEARED for the sequenced scope; DESIGN + CEO clear.
  T4 (duplicate-send) is a critical gap to fix within P2-0. Ready to implement
  T1 first.

NO UNRESOLVED DECISIONS
