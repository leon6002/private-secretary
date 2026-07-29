# Phase 3 (v1) — Local single-process secretary on macOS (MacBook Air)

Status: ENG-REVIEWED + OUTSIDE-VOICE (codex) (2026-06-13) — architecture locked
Supersedes: the cloud "option 2" assumption AND the earlier multi-process draft.
Form factor = a **single, long-running local macOS process** on Leo's MacBook Air.

## 0. v1 scope (locked)

**This phase = ONE local always-on process (LaunchAgent) that owns detection + the
localhost cockpit. Phone / Telegram / remote access → next phase.**

Honesty on data location (corrected per outside voice): "local" means **storage** —
loop-state, personas, tokens stay on the device (Keychain). It is NOT fully on-device
**processing**: message content is sent to Anthropic via the Agent SDK, and Jira/Notion
context rides hosted MCP. No cloud *host* and no cloud *state store*; that's the claim.

MacBook Air reality: a daily-driver that suspends on lid-close. Semantics = **sync while
awake, catch up after wake** (on resume, detect the wall-clock gap and poll). Running v1
on the Air is the test of whether catch-up is good enough before buying an always-awake
host. (If always-on is truly needed → Mac mini, same code.)

## 1. Architecture (single-process, locked)

```
ONE LaunchAgent (KeepAlive) — owns everything in-process:
  ┌─────────────────────────────────────────────────────────────┐
  │ poll scheduler (in-proc timer + wall-clock-gap wake detect)   │
  │ DETERMINISTIC spine: relay/core (cursors, dedup, status, policy)│
  │   → poll Slack/Gmail (Direct API) → filter/dedup IN CODE       │
  │   → only on CANDIDATES, call Claude (Agent SDK):               │
  │        read-only context tools → structured "suggested actions"│
  │ sole STATE owner (loop-state.json; no cross-process lock needed)│
  │ cockpit HTTP server (localhost, loopback-only)                 │
  │ DETERMINISTIC executors — perform send/draft/event AFTER your   │
  │   cockpit approval. The model NEVER holds send authority.       │
  └─────────────────────────────────────────────────────────────┘
  context lookups (R5): Jira / Notion via hosted MCP or REST (read-only)
  liveness: launchd KeepAlive restarts; in-proc heartbeat + on-wake self-check;
            failure → macOS local notification (on-device, no phone)
  deferred → next phase: Telegram/phone notify+approve+edit, Tailscale, Socket Mode
```

**Why single-process (what it dissolves):** one process owning state deletes
cross-process file locking (and the cross-sleep stale-lock bug); an in-process scheduler
+ wall-clock wake detection removes launchd timer/sleep coalescing ambiguity; "is it
alive" collapses to KeepAlive + heartbeat (most of a separate watchdog gone); Claude is a
called subroutine on read-only tools (not an always-on agent holding send tools), so the
prompt-injection blast radius and the model cost both shrink. relay/core stays the
deterministic spine — this is closer to the existing code split, not a fork.

## 2. Credentials (corrected)

- **Slack App** (Taiv workspace): user token + history/read/send scopes. Needs Taiv admin approval.
- **One Google OAuth client**: Gmail + Calendar scopes. **Requires a GCP project** +
  sensitive-scope consent screen + admin trust (no Pub/Sub — polling, not push).
- **Jira / Notion**: hosted MCP **or** direct REST (R5 read-only lookups). "Official
  self-hostable for both" is not available — Atlassian's Jira MCP is hosted-remote,
  Notion's primary is hosted. First task picks hosted-MCP-or-REST per platform.
- All secrets in **macOS Keychain**.

## 3. Source vs context vs executor (role correction, per #10)

- **Origination sources** (scanned for new action items): **Slack, Gmail** (+ WeChat later). Direct API.
- **Calendar:** Direct API, but its role is **executor target** (`create_event`) +
  **conflict-check context** (`list_events`) — NOT a scanned origination source.
- **Jira / Notion:** R5 context lookups + future executor targets — never scanned to originate.

## 4. Requirements that REMAIN (single-process didn't dissolve these)

- **Lossless cursors (#5/#6):** Gmail `historyId`, Calendar `syncToken`, and
  full-pagination-before-watermark-commit. Kills the "equal-timestamp unseen message gets
  dropped" gap and partial-pagination skips. The connector contract needs opaque cursors
  + page-level commit, not just `normalize()`.
- **Cursor/ID migration (#7):** existing loop-state has connector-era Slack ID formats;
  the Direct-API adapter needs a migration or it dup/misses old messages.
- **Adapter scope is real work (#8/#9):** `relay/sources` today is only `normalize()`.
  The Direct-API adapter must add polling, pagination, auth, retries, cursors, and
  attachment download/extraction. The Slack normalizer's `reply_user_ids` /
  `user_answered_after` were connector-enriched — must be reconstructed via extra thread +
  sent-message queries.
- **Shadow-mode gate (#16):** the existing 4/20 gate samples came through the Claude Code
  connectors; they don't validate Direct-API payloads / new schemas / unattended behavior.
  The new runtime needs its own shadow-mode dataset before auto-detection turns on.
- **Per-platform idempotency (#15):** beyond T4's `executing` marker, each executor
  (Slack send, Gmail draft, Calendar event) needs a deterministic post-crash
  verify/correlation check.
- **macOS ops (#18):** LaunchAgent minimal env, Node path (avoid nvm-only), Keychain
  prompt/hang handling, OAuth needs an interactive browser once, Documents-folder privacy prompts.
- **Bounded backfill (#20):** a multi-day sleep can yield thousands of messages — batch,
  checkpoint, cap per cycle, isolate poison messages; never hold a long operation open.

## 5. Prerequisite dev (before v1 build)

- **A2 — T10:** stable task_id dedup (`relay/core/tasks.ts`).
- **A3 — skip-already-handled** (`relay/core`): Leo last sender / already replied → skip.
- **(T5b persona lock now optional** — single state owner removes the concurrent-writer case; revisit only if a second writer appears.)
- **B — shadow-mode validation set** on the new runtime (replaces relying on the old gate samples).
- **C — external (parallel, long lead):** Slack App + Taiv admin; Google OAuth client + GCP project.

## 6. v1 build sequence

1. **Connectors:** Direct-API Slack/Gmail (+ Calendar executor/context) with opaque cursors,
   pagination-commit, attachments, Keychain; Jira/Notion hosted-MCP-or-REST. Verify headless read + send.
2. **Single process shell:** LaunchAgent (KeepAlive) hosting scheduler + state owner +
   cockpit HTTP + executors; wall-clock-gap wake detection; in-proc heartbeat.
3. **Deterministic-first loop:** relay/core poll/filter/dedup → call Claude (Agent SDK,
   read-only tools, structured output) only on candidates → queue rows.
4. **Cockpit (T7/T8):** localhost approve/edit/skip → deterministic executors; crash-safe send (T4 + #15).
5. **Liveness:** KeepAlive + on-wake self-check + macOS local notification on failure.
6. **Shadow-mode** the new runtime; enable live auto-detection only after the gate passes.

## 7. NOT in scope (deferred, with rationale)

- Telegram / phone notify + approve + edit-by-reply — next phase.
- Tailscale / remote access / auth + TLS — rides with phone access.
- Real-time Slack Socket Mode — polling suffices for catch-up; fast-follow.
- Multi-process / separate watchdog process — dissolved by the single-process design.
- SQLite — single state owner; JSON + atomic write is enough.
- Real Gmail auto-send — capability unlocked, kept draft-only for v1 safety.
- Cloud / Mac mini always-awake host — only if catch-up proves insufficient.

## 8. What already exists (reused)

- `relay/core` (cursors, dedup, status machine, tasks, executor policy, metrics) — 134 tests. The deterministic spine, verbatim.
- `relay/sources` `normalize()` pure fns — the Direct-API adapter wraps these (and adds the I/O the contract lacks).
- T5 atomic state writes — crash-safe persistence for the single owner (lockfile no longer load-bearing).
- Cockpit design T7/T8 — built in-process as the v1 surface.

## 9. Implementation Tasks
P1 blocks v1; P2 same-phase; P3 follow-up.

- [ ] **A2 (P1, human ~3h / CC ~30min)** relay/core/tasks.ts — stable task_id dedup. Verify: dup-id test green.
- [ ] **A3 (P2, human ~2h / CC ~20min)** relay/core — skip-already-handled (last sender / already replied). Verify: unit test.
- [ ] **T-conn (P1, human ~3d / CC ~5h)** relay/sources + executors — Direct-API Slack/Gmail/Calendar: opaque cursors (historyId/syncToken), pagination-commit, attachments, Keychain; reconstruct reply_user_ids/user_answered_after. Verify: mocked-API tests + headless read/send smoke + cursor-gap (no dup/miss).
- [ ] **T-ctx (P1, human ~halfd / CC ~1h)** Jira/Notion hosted-MCP-or-REST read-only lookups. Verify: a headless R5 lookup returns issue + page.
- [ ] **T-proc (P1, human ~3d / CC ~4h)** single LaunchAgent: scheduler + state owner + cockpit HTTP + executors; wall-clock wake; heartbeat. Verify: end-to-end candidate→Claude→queue with mocked sources.
- [ ] **T-cockpit (P1, human ~3d / CC ~4h)** in-process localhost cockpit (T7/T8): approve/edit/skip → deterministic executors; crash-safe send (T4 + per-platform verify #15); loopback + CSRF. Verify: approve→transition→executor integration.
- [ ] **T-live (P2, human ~1h / CC ~15min)** KeepAlive + on-wake self-check + macOS local notification on failure. Verify: kill process → relaunch + notification.
- [ ] **T-backfill (P2, human ~halfd / CC ~1h)** bounded backfill (batch/checkpoint/cap) across multi-day sleep. Verify: large-gap integration test.
- [ ] **T-gate (P2, human ~1d / CC ~2h)** shadow-mode dataset on the new runtime; gate computed from it. Verify: gate runs on shadow data.
- [ ] **T-ops (P2, human ~halfd / CC ~1h)** macOS ops: LaunchAgent env, Node path, Keychain, OAuth browser, Documents privacy. Verify: clean-machine install runbook.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 20 problems; single-process alternative adopted; 4 false claims corrected, 8 hardening reqs kept |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | scope reduced to v1; single-process architecture locked; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** 20 findings; keystone "simpler single-process" approach adopted (dissolves cross-process locking #4, launchd timer ambiguity #2, separate-watchdog #3/#19, send-authority-in-agent #17). False claims corrected (#1 data-location, #13 MCP hosted, #14 GCP-required, #8/#9/#10 reuse-scope). Hardening kept (#5/#6/#7 cursors, #15 idempotency, #16 shadow-gate, #18 macOS ops, #20 backfill).
- **CROSS-MODEL:** review + outside voice converged on single-process after the user revisited the keystone.
- **VERDICT:** ENG CLEARED — single-process v1 architecture locked. Ready to implement after prerequisites A2/A3 + connectors land and the shadow-mode gate passes.

NO UNRESOLVED DECISIONS
