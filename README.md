# PrivateSecretary

A local AI chief-of-staff. It watches your own chat streams (Slack / Gmail /
WeChat), works out what actually needs *you*, and keeps a prioritised daily
to-do list. Each item can spawn AI-drafted sub-actions — a calendar event, an
email draft, a ticket — which **you** send. Nothing goes out without a click.

Runs entirely on your machine. Inference goes through the Claude Code CLI
(`claude -p`), so with a Claude subscription there is no API bill.

> **Read [SETUP.md](SETUP.md) before you try to run it.** A fresh clone passes
> the test suite immediately, but it cannot read a single message until you have
> connected *your* accounts — by design: the engine never guesses whose inbox it
> is looking at.

## Quick start (macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/LeoTaivDev/private-secretary/main/scripts/install.sh | bash
```

One line installs Node.js if needed (via Homebrew), clones into
`~/private-secretary`, builds the cockpit, starts the 24/7 daemon + the triage
UI (`http://127.0.0.1:4317`) as launchd agents, and links the `/relay` skill
into `~/.claude/skills`. Re-running it updates to the latest version. Then open
the cockpit → Connections to link your accounts.

## What it does

| | |
|---|---|
| **Watches** | Slack DMs/MPIMs, Gmail (multi-mailbox), WeChat 1:1 + groups (macOS only) |
| **Produces** | A ranked daily list (A/B/C/D) with, per item, a digest, the current state, and concrete next steps |
| **Sub-actions** | Calendar event · email draft · reply draft · reminder. All human-confirmed |
| **Learns** | Every approve / edit / skip is recorded as a label, so accuracy is measurable rather than vibes |

Hard rules the engine will not break:

- **Nothing auto-sends.** Calendar / reply / relay / forward always need explicit approval — hard-coded, not configurable.
- **Never guess a recipient.** A name resolves only on an exact, unambiguous match; otherwise the item is blocked as needing info. A wrong recipient is the worst failure.
- **Never invent a missing parameter.** Missing info blocks approval instead of being filled in.
- **Message content is data, never instructions.** Text in an email cannot tell the engine what to do.

## Layout

```
relay/core/      pure logic, no I/O — action schema + status machine, task
                 identity, trigger filter, recipient resolution, dedup cursors,
                 executor rules, metrics, persona v3, anchors (validator)
relay/io/        filesystem + APIs — state, labels, Keychain, Slack/Gmail/
                 Calendar/WeChat clients, identity + business-context config
relay/proc/      the passes — scan → draft → consolidate → refresh → plan →
                 persona-update, plus execution
relay/eval/      accuracy baseline + zero-token replay harness
relay/cockpit/   the local web UI (localhost:4317) you triage in
scripts/         daemon entrypoints, one-off migrations, smoke tests
specs/           design docs; start with action-item-engine.md
config/          YOUR accounts + business facts (gitignored; .example files committed)
personas/        per-contact profiles (gitignored — see personas/README.md)
state/           queue, cursors, labels, audit log (gitignored)
```

## Commands

```bash
npm test           # 552 tests, no credentials needed
npm run typecheck
npm run relay -- queue state/loop-state.json     # show the pending queue
npx tsx scripts/run-cockpit.ts --port 4317       # the triage UI
npx tsx scripts/run-notify.ts                    # the daemon (needs setup)
```

## Measuring accuracy

Because "it feels better" is not evidence, the engine ships an eval path:

```bash
npx tsx scripts/export-labels.ts    # snapshot decided items into state/labels.jsonl
npx tsx scripts/baseline.ts         # per-type precision + confidence calibration
npx tsx scripts/freeze-corpus.ts    # freeze a replay corpus (read-only)
```

Numbers are always reported **per action type** — a single blended "accuracy"
hides the type that is actually broken. See `eval/baseline-*.md` after a run.

## Status

Working: scanning, drafting, task grouping, thread refresh, daily ranking,
persona memory with an evidence-gated write path, the cockpit, calendar
creation, Gmail drafts, Slack sends, the label/eval layer.

Known gaps are tracked in `specs/` and `docs/`. Notably: a to-do has no durable
identity across ticks yet (it is regenerated each refresh), task identity is a
title hash, and there is no Jira executor. Those are the next work items.

## License / privacy

Private. The engine reads your mail and messages and writes profiles about the
people you talk to. `personas/`, `state/`, `config/` and `projects/` are
gitignored for that reason — **do not commit them**, and think twice before
sharing a repo that has them in its history.
