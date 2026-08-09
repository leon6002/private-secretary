# Roadmap and shipped history

Moved out of CLAUDE.md 2026-08-09: it is history, and CLAUDE.md is loaded into
every session (target: under 200 lines). Read this when you need to know what
already shipped or what a phase means; CLAUDE.md keeps only the current state
and the open items.

## Roadmap
- PR 1 (landed): engine skeleton — schema, status machine, cursors, queue, per-source
  fault isolation, RelayExecutor.
- PR 2 (landed): all six action types; all execute only AFTER approval (human-in-the-
  loop — reply sends to the sender after approval, not held back); calendar
  conflict-check; execution_receipt idempotency; style-profile lazy cache;
  cross-language gate; ignore/task auto-execute at confidence ≥ AUTO_EXECUTE_CONFIDENCE (0.9).
- PR 3 (landed): MessageSource contract + slack #channels (single-account, MCP).
  Action Items originate ONLY from person-to-person messages; Jira/Notion are
  context-lookup + (future) executor targets, never scan triggers.
- PR 4 (landed): Persona Layer v3 (specs/persona-v3.md) — hierarchical schema,
  provenance + evidence, R1 write chokepoint, v2→v3 migration, /persona-bootstrap
  (Phase A, staged + promote, resumable), Phase B round-end persona updates,
  R3 merge cards, R5 full-context rule. NO style-profile auto-rebuild (R4 cancelled),
  no disclosure block (R6 deleted), open_threads compaction deferred (R2).
- Phase 2 (eng-reviewed 2026-06-12; specs/phase2-cockpit-design.md). PRODUCT UNIT =
  TASK. 3-screen LOCAL cockpit (Queue / People / Connections; Task View dropped —
  task context lives in the Queue). Sequenced: **P2-0 core (LANDED)** = task model
  (task_id + tasks registry + groupByTask), persisted detail-pane context, flush
  queue (pendingExecution), crash-safe send (markExecuting), restore transition,
  atomic state writes + stale-lock reclaim. **P2-1/P2-2 (next)** = the cockpit web
  app: thin local server importing relay/core, renders loop-state+personas, triage-
  only (approve/edit/skip via core; Claude Code stays the MCP runtime, flushes sends).
  DEFERRED to Phase 3: standalone Claude-API runtime, multi-account mcp_servers,
  Socket Mode + Gmail-watch event detection, real Gmail send. Visual source of truth:
  specs/phase2-stitch/ (IBM Plex/#2563EB, 3-screen nav).
- Slack one-click auth (landed 2026-08-09): PKCE OAuth replaces "create your own
  Slack app + paste an xoxp- token". One Taiv-owned Slack app, its public
  client_id shipped in relay/io/slack-oauth.ts; the browser redirects to
  localhost, the token is exchanged on-device and stored in Keychain. NO server
  of ours is in the path — that also keeps Google's CASA carve-out for
  local-only apps, so never add a token broker. Legacy hand-pasted xoxp- tokens
  still work (readSlackToken dual-mode; regression test). Cockpit Connections
  drives connect/disconnect; disconnect calls auth.revoke before deleting.
  Docs: `.claude/docs/slack-oauth.html` (flow + rate limits),
  `.claude/docs/slack-app-setup.html` (console walkthrough).
  OPEN, in priority order:
  1. **Marketplace listing.** Distributed non-Marketplace apps get 1 req/min and
     15 objects per request on conversations.history/.replies; the bucket is
     (app, INSTALLING user's workspace), so colleagues in ONE workspace share a
     single request per minute. That, not the per-user rate, is what decides
     whether a team can use this. Listing is the only path back to the old
     limits. Measure a real-size workspace before committing to a rewrite — one
     production round (6 conversations, 30 messages) took 94s with no 429s,
     which is milder than the documented worst case and not yet explained.
  2. **Scan loop vs the cap.** relay/sources/slack-direct.ts asks for
     `limit: 200`, a number Slack now silently caps at 15. It degrades quietly
     (callRaw retries 429 with Retry-After) rather than erroring, so at minimum
     make truncation observable.
- Phase 3: trust-based auto-send tiers; WeChat read via local sqlcipher decrypt
  through `ylytdeng/wechat-decrypt` MCP server (driven over stdio JSON-RPC by
  `relay/io/wechat-cli.ts`; supersedes the earlier `@walkerch/wxecho` path —
  see `specs/wechat-decrypt-migration.md`). Still WeChat 4.1.8.x-pinned per
  `specs/wechat-local-decrypt.md`. WeChat send via Customer Service official
  API (公众号/客服号 only — personal 1:1 send remains clipboard-manual).
