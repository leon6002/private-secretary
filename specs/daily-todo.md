# Daily ToDo — the secretary's core loop (design)

Status: PROPOSED (2026-07-06). Converges the product from "one card per inbound
message" to "**one prioritized daily ToDo list**": every source dynamically
updates the list, each task is ranked A/B/C/D with a reason, and each task shows
full context + concrete sub-actions (some the AI can do one-click) + the
supporting materials ("entities") you need to finish it.

## 1. The shift

TODAY: the Queue is message-triggered cards grouped into tasks. The unit the user
acts on is a card (reply/task/calendar/...).

TARGET: the unit is the **TASK**. The Queue becomes a **daily plan** — open tasks
ranked A→D, each an expandable item with:
- **Context**: what it is, why it matters now, the project it advances (project_id
  already exists), the originating thread(s).
- **Sub-actions**: the concrete steps to finish it. Each has an assignee (AI | Me)
  and a status; AI-executable ones (send Slack, create calendar event, draft
  Gmail) carry a one-click "approve → AI does it".
- **Entities**: the supporting materials the task references — a flight status, a
  hotel confirmation, a chip price, an Excel someone sent in a chat — surfaced as
  chips/cards with a value (when known) or a POINTER to where it lives.

Cards don't disappear; they become the sub-actions inside a task.

## 2. Data model growth (on top of today's ActionItem/Task)

Today: `ActionItem {action_type, target, params, draft, headline, summary,
next_actions[], project_id, task_id, context}`; `TaskCluster` from groupByTask.

Add a **task-plan** layer (per task_id), produced by a new pass, stored in
loop-state (sibling to `tasks` registry):

```
TaskPlan {
  task_id
  priority: { tier: "A"|"B"|"C"|"D", rank: number, why: string }   // ranking pass
  sub_actions: [{
     id, text,                       // "Contact Marriott for late check-in"
     assignee: "ai" | "me",
     status: "open" | "done" | "executing",
     // when the AI can do it, the concrete action to run on one-click approve:
     executable?: { action_type, target, params, draft? }          // reuses executors
  }]
  entities: [{
     kind: "flight"|"file"|"price"|"doc"|"confirmation"|"person"|...,
     label, value?,                  // "UA102" / "Delayed 3h" ; "创达报价" / "¥6712"
     source?: { platform, ref, when } // "WeChat · 张工 · 2026-06-10" + a pointer
  }]
}
```

The existing card fields feed this: a task's member ActionItems → sub_actions
(reply/calendar/etc. become AI-executable sub_actions via their existing target/
params; a `next_actions` bullet with no executor becomes a "Me" sub-action).

## 3. New daemon passes (after draft → consolidate → refresh)

- **PLAN pass (ranking + sub-actions + entities)** — once per cycle (or on
  change), an LLM reads all open tasks (+ their cards, project RAG, threads) and
  emits, per task: the priority tier+rank+why, the sub-action list with AI/Me
  assignment, and the entities. Pure-core split holds: LLM proposes, core
  validates/stores. Cheap-ish (one call over compact task rows; entities/context
  from the cards we already have).
- Entities that need a LIVE value (flight status, a price) are surfaced as a
  POINTER + last-known value, NOT auto-fetched — we have no flight/price API. A
  file "in the WeChat chat with X on Jun 10" is a pointer the user clicks, not an
  upload. (Live fetch is a later tier.)

## 4. One-click sub-action execution (safety tiers)

Reuse the existing approval + executor path, but at the SUB-ACTION level:
- **One-click AI (real MCP send)**: Slack send, Calendar create — the AI executes
  on a single approve (already conflict-checked / receipt-idempotent).
- **Prepare, you finish**: Gmail is DRAFT-ONLY today → one-click creates the draft;
  you press send in Gmail. WeChat send stays clipboard-manual.
- **No MCP → reminder only**: "book flight UA-xxx", "pay invoice" → a Me sub-action
  the AI can't execute; it surfaces the entities you need and marks it yours.
Hard constraints unchanged: reply/relay/forward/calendar always require approval;
recipient ASK-not-GUESS; nothing sent silently.

## 5. Cockpit — the daily view

- Queue screen → **Today**: tasks in A/B/C/D sections (or a single ranked list
  with A/B/C/D chips), each showing title · project · priority-why · progress.
- Task detail: Context (summary + thread) · **Sub-actions** (each row: checkbox,
  text, AI/Me chip, and an "Approve & do" button when AI-executable) · **Entities**
  panel (chips/cards with value + source pointer). Matches the target mockup
  (Sub-actions + Entities + per-item approve).
- Keep per-sub-action approve; keep the existing card executors underneath.

## 6. Reuse vs new

REUSE: ActionItem + executors (slack/gmail/calendar), task_id + groupByTask,
project_id RAG, draft/consolidate/refresh passes, the `claude -p` LLM path.
NEW: the PLAN pass (rank + sub-actions + entities), the TaskPlan store, the Today
view + task-detail redesign, sub-action-level execution wiring.

## 7. DECIDED (2026-07-06)

1. **Today REPLACES the Queue** as the primary screen; cards become sub-actions.
2. **ABCD = holistic LLM judgment** against the fixed rubric (deadline/time-
   sensitivity, who's blocked on Leo, revenue/deal impact, project stage).
3. **Entities v1 = all four kinds**: files/attachments (pointers), prices/quotes,
   confirmations/bookings, deadlines/dates. Pointers + last-known values, no live
   fetch.
4. **One-click tiers = recommended**: Slack-send + Calendar-create = one-click AI;
   Gmail = prepare draft; no-MCP (book flight / pay) = Me reminder.

### Original open decisions (kept for context)

1. **Does "Today" REPLACE the current message-card Queue as the primary screen,**
   or sit alongside it? (Recommend: it becomes the Queue; cards live as
   sub-actions inside tasks.)
2. **ABCD rubric** — rank by what? Recommend a holistic LLM judgment against a
   fixed rubric: (a) hard deadline / time-sensitivity, (b) who's blocked waiting
   on Leo, (c) revenue/deal impact, (d) project stage/momentum. A = urgent+high-
   impact, D = low/defer. Do you want to weight any factor (e.g. revenue first)?
3. **Entities scope now** — pointers + last-known values only (no live flight/price
   fetch) for v1? Which entity kinds matter most to you (files, prices,
   confirmations, deadlines, people)?
4. **One-click tiers** — OK to auto-execute Slack-send + Calendar-create on a
   single approve, Gmail = prepare-draft, everything else = Me/reminder?

## 8. Phased plan (after decisions)

- **P1 — Plan pass + Today view (read-only ranking)**: rank tasks A/B/C/D + why;
  Today screen renders the ranked list + task detail with sub-actions (from
  existing cards) + a basic entities panel. No new execution yet.
- **P2 — Entities extraction**: the LLM surfaces referenced materials + source
  pointers into the entities panel.
- **P3 — Sub-action execution**: per-sub-action approve → executor (Slack/Calendar
  one-click; Gmail prepare). AI/Me assignment + status.
