---
paths:
  - "relay/io/slack*"
  - "relay/sources/slack*"
  - "relay/cockpit/slack*"
  - "scripts/auth/slack*"
---

# Slack integration

## One-click auth (landed 2026-08-09)

PKCE OAuth replaced "create your own Slack app + paste an xoxp- token". One
Taiv-owned Slack app; its public `client_id` ships in `relay/io/slack-oauth.ts`.
The browser redirects to localhost, the token is exchanged on-device and stored
in Keychain.

**No server of ours is ever in the token path.** That is not only a privacy
stance — it carries Google's CASA carve-out for local-only apps on the Gmail
side. Never add a token broker.

- `readSlackToken` is the chokepoint and is dual-mode: legacy hand-pasted
  `xoxp-` strings still work and are returned untouched, with no network call.
  Regression test in `slack-oauth.test.ts`.
- Tokens rotate whether or not Slack's rotation setting is on: ~12h access
  token, 30-day refresh window. `reconnectBy` (refresh window) is the
  user-facing deadline; `expiresAt` is machinery and must never be surfaced as
  a warning, or the row reads red permanently.
- A user-token refresh answers TOP-LEVEL, not nested under `authed_user` like
  the documented initial exchange. Verified against the live API.
- Disconnect calls `auth.revoke` BEFORE deleting the Keychain entry — deleting
  first leaves a live grant nothing can withdraw.

Docs: `.claude/docs/slack-oauth.html` (flow + rate limits),
`.claude/docs/slack-app-setup.html` (console walkthrough).

## Rate limits — open item

Distributed non-Marketplace apps get **1 request/minute and 15 objects per
request** on `conversations.history` / `.replies`. The bucket is
`(app, INSTALLING user's workspace)`, so customers at different companies never
contend — but **colleagues in ONE workspace share a single request per minute
between them**. That, not the per-user rate, decides whether a team can use
this. Marketplace listing is the only path back to the old limits.

`relay/sources/slack-direct.ts` asks for `limit: 200`, a number Slack now
silently caps at 15. It degrades quietly (`callRaw` retries 429 with
Retry-After) rather than erroring, so at minimum make truncation observable.

One production round (6 conversations, 30 messages) took 94s with no 429s —
milder than the documented worst case and not yet explained. Measure a
real-size workspace before rewriting the scan loop.
