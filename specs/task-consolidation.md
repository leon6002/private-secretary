# Task Consolidation + Commitment→Calendar (design)

Status: PROPOSED (2026-06-23). Author note: triggered by real cockpit feedback —
two WeChat cards (张心良 "采埃孚前瞻" reply + Yukun_Lu task) that are ONE task
(ZF suspension project → real-car test @ Anting → visit 张工) showed as two
separate "Standalone" cards, and never updated after the thread later settled the
time (周三 9:30) nor produced a calendar event.

## 1. Why it happens today (grounded in code)

**A. No cross-sender task grouping.** The daemon drafts **per-sender, one-shot**
(`relay/proc/draft.ts` groups candidates by `senderHandle`, one LLM call each) and
**never assigns `task_id`** (grep: zero `task_id` writes in `relay/proc/` or
`relay/sources/`). `groupByTask` (`relay/core/tasks.ts`) only clusters cards that
**share a `task_id`**; with none assigned, every daemon card is its own ungrouped
"Standalone" cluster. The cross-tick supersede (`scan-loop.ts` `clusterKey`) keys on
`platform::sender_handle` — same sender only — so two different WeChat contacts
about one project never combine.

**B. Open tasks never re-read the thread.** WeChat detection is **unread-gated**
(`get_recent_sessions` unread = trigger). The later messages where the time got
settled — Leo read/participated in them — were never re-surfaced, so the daemon
**never saw the resolution**. There is no logic to (i) refresh an OPEN task's
thread to catch resolution in already-read messages, or (ii) turn a committed time
into a `calendar` action. The drafting LLM only ever sees ONE sender's NEW messages.

## 2. What already exists (build on these — do NOT reinvent)

- `relay/core/tasks.ts`: `groupByTask`, `TaskRegistry`/`TaskMeta`, and a complete
  deterministic dedup: `dedupTaskMints` (normalized-title equality, cross-round +
  cross-people) + `applyTaskRewrites`. The Phase-2 design is explicit: **the LLM
  decides grouping; core is the deterministic guard.** The daemon is simply
  MISSING the LLM grouping step.
- `loop-state.tasks` (the registry) is already loaded + passed to `groupByTask` in
  `relay/cockpit/api.ts`.
- `ActionItem.task_id` + `ActionItem.context` already exist.
- Calendar: `relay/core/calendar-conflict.ts` (conflict-check) + the calendar
  executor; `calendar` action_type already in the draft schema. Calendar ALWAYS
  requires approval (hard constraint, `relay/core/executors.ts`).
- WeChat thread re-read primitive already exists: `wechatHistory(name, limit)`
  (used today only for fresh-message context).

## 3. Design — a "task consolidation" pass

A new daemon stage that runs AFTER per-sender drafting, over the **union of open
cards** (this tick's new ones + already-open suggested/approved). It is the
Phase-2 "task model" LLM step the daemon currently skips. Pure-core split holds:
the LLM proposes, `tasks.ts` dedups deterministically.

```
per-sender draft (unchanged)
        │  new suggested cards
        ▼
consolidation pass (NEW)
  1. collect open cards (suggested + approved) + their headline/summary/sender/task_id
  2. [Stage 2] for each open task's conversation, re-pull thread history
  3. ONE LLM call → proposed groupings + (Stage 2) resolution/calendar
  4. dedupTaskMints(registry, mints) → additions + rewrites   (core, deterministic)
  5. applyTaskRewrites(cards) ; set task_id ; persist registry additions
        ▼
groupByTask renders one cluster per task (cross-sender)
```

### Stage 1 — cross-sender grouping (smaller, verifiable first)

- LLM input: the open cards as compact rows (`id, sender_name, headline, summary,
  existing task_id?`). NOT full message bodies — keep it cheap.
- LLM output (new tool schema, separate from draft-prompt): for each card, either
  `{task_id: <existing>}` or `{mint: {id, title}}`. Caution rule: only group cards
  that are clearly the same real-world task; when unsure, leave standalone
  (over-merging unrelated cards is the worst failure — mirrors the ASK-not-GUESS
  ethos).
- Run `dedupTaskMints` (title-equality folds a second mint of the same task) →
  persist `additions` to `state.tasks`, `applyTaskRewrites` to the cards, write
  `task_id` onto each card.
- Result: the two ZF cards share a `task_id` + title (e.g. "采埃孚悬挂 实车测试@安亭 ·
  约张工") → `groupByTask` shows them under one cluster instead of two Standalone.

### Stage 2 — thread re-read + commitment→calendar

- **Scoped re-read (the one architectural departure):** for conversations that
  ALREADY have an open card, re-pull recent thread history (WeChat
  `wechatHistory`, Slack `slack_read_channel`, Gmail thread). This breaks pure
  unread-gating ON PURPOSE but only for already-surfaced conversations — a bounded
  set, so bounded cost. Everything else stays unread-gated.
- The consolidation LLM, now seeing the FULL recent thread, can:
  - **update** a task's summary/next_actions as it resolves (e.g. "time set: Wed
    09:30");
  - **emit a `calendar` action** attached to the task when a meeting time + place
    is committed in the thread (params `{title, start, end, attendees}`). Still
    approval-gated; conflict-checked on approve via `calendar-conflict.ts`.
  - **supersede** the now-resolved reply/task cards (the "ask 张工 to schedule"
    task collapses once the calendar action exists), reusing the existing supersede
    machinery but keyed by task instead of sender.
- Commitment detection is conservative: a calendar action only when the thread
  shows an explicit agreed time. Ambiguous → keep the task, no event. Never invent
  a time (hard constraint: never fabricate).

## 4. Code touch-points

- NEW `relay/proc/consolidate-prompt.ts` — system + tool schema for the grouping
  (Stage 1) and resolution/calendar (Stage 2) call. Mirrors `draft-prompt.ts`.
- NEW `relay/proc/consolidate.ts` — orchestrator: collect open cards, (Stage 2)
  fetch threads, call LLM (same injected `LlmCaller`), run `dedupTaskMints` /
  `applyTaskRewrites`, return `{updatedActions, registryAdditions, newActions}`.
- `relay/proc/scan-loop.ts` — call consolidate after drafting; persist task_ids +
  registry additions + any calendar actions under the same state write.
- `scripts/run-notify.ts` — gate behind `--consolidate` (default ON once Stage 1
  lands) + a cadence guard (below).
- `relay/core/tasks.ts` — reuse as-is (no change expected for Stage 1).
- Tests: consolidate.test.ts (stub LLM → assert grouping + dedup + calendar
  emission); a scan-loop integration test (two cards same task → one cluster).

## 5. Cadence & cost

- Stage 1 is one LLM call over compact card rows — cheap. Guard: run only when
  there are ≥2 open ungrouped cards OR new cards landed this tick (skip otherwise).
- Stage 2 adds N thread re-reads (N = open tasks touched) + a richer prompt. Guard:
  re-read a task's thread at most once per M minutes (e.g. 15) to bound cost.
- All under the `claude -p` subscription path (zero API $). Note: consolidation
  adds to the per-tick LLM time already flagged as running under the state lock —
  fold into the deferred "draft/consolidate outside the lock" refactor.

## 6. Risks / open questions

- **Over-merging.** Title-equality dedup is safe; the risk is the LLM minting the
  same title for genuinely different tasks, or grouping loosely-related cards.
  Mitigation: conservative grouping rule + title-equality (not fuzzy) dedup. Open:
  do we want a cockpit "split task" affordance for mistakes?
- **Re-read scope creep.** Must stay limited to conversations with an open card,
  else WeChat re-reads everything. Open: TTL value (15 min?) and whether Slack/Gmail
  re-read is worth it now or WeChat-only first.
- **Calendar false positives.** Approval gate + conflict-check contain the blast
  radius; a wrong event is reviewed, never booked silently.
- **Interaction with cross-tick `clusterKey` supersede.** Order: per-sender
  supersede first (unchanged), then task consolidation on top. Need a test that the
  two compose without dropping user-touched cards.
- **task_id stability across restarts.** Registry persists in loop-state; mints are
  id-stable via dedup. Confirm a restart mid-consolidation can't orphan a task_id.

## 7. Recommended sequencing

1. **Stage 1 (cross-sender merge)** — consolidate-prompt + consolidate.ts +
   scan-loop wiring + tests. Verifiable immediately on the two ZF cards. No
   unread-gating change, no calendar.
2. **Stage 2 (re-read + commitment→calendar)** — scoped thread re-read + calendar
   emission + supersede-by-task. The bigger, behavior-changing half.

## 8. Decisions (2026-06-23)

- **Sequencing: Stage 1 first.** Build cross-sender merge now; Stage 2 after.
- **Stage 2 re-read: all three platforms** (WeChat + Slack + Gmail), not WeChat-only.
- **Re-read TTL:** a per-conversation cooldown so the same thread isn't re-pulled
  every tick — **10 min** (decided 2026-06-23).
- **Calendar target:** all events are created on `huizhezheng@gmail.com` (the
  calendar-creation API connected in a separate session, 2026-06-23). Stage 2's
  commitment→calendar action books there.

Stage 1 is the active build. Stage 2 (scoped all-platform re-read + commitment→
calendar) is deferred to its own PR.
