# Project Discovery — a self-maintaining project set (design)

Status: APPROVED 2026-06-28. Goal: the secretary keeps an accurate, current map of
what each company (OSYX / 欧思克斯-OUS / Taiv) is actively working on, WITHOUT Leo
enumerating projects by hand. The project set is the RAG that grounds every Action
Item (`loadProjects` → draft/refresh), so its accuracy directly decides card quality.

This is the project analogue of `persona-bootstrap`: a staged → review → promote
batch job, plus a self-maintenance loop. It does NOT run inside the 30-min scan.

## 1. Core principle: the conversation container IS the project unit

Humans already partition work into containers — a Slack channel, a WeChat group, an
MPIM (group DM), a Jira epic. Discovery = enumerate containers → classify → summarize
→ merge across surfaces. Validated by the 2026-06-28 manual dig: every real OSYX
project mapped 1:1 to a `#channel` / WeChat group / MPIM.

But some projects have NO container yet (e.g. Renesas chip-cascading lived only in a
few 陈古龙/Sandro DMs + a "discuss Monday" mention). So container enumeration alone
is necessary-but-not-sufficient. Three layers + one escape hatch:

- **L1 Container census** (backbone, high precision) — channels / groups / MPIMs / Jira.
- **L2 Residual mining** (catches container-less projects) — over everything NOT in a
  project container: high-frequency 1:1 DM clusters, strategy/general channels
  (`#business`, `#all-osyx`), and explicit deliverable/commitment signals ("need to
  produce a SoW", "出报价", "周会讨论 X"). An LLM "what active effort here is NOT an
  existing project?" pass → emergent candidates (always human-reviewed).
- **L3 MISC-cluster detector** (self-blind-spot report) — every card the daemon can't
  map to a project lands in `project_id = MISC`. A topic that recurs in MISC across
  days IS a container-less project not yet filed. The system flags its own gaps.
- **Escape hatch** — the review step lets Leo add a project the system missed (a
  head-only project with almost no chat). He adds it ONCE; the system then tracks +
  enriches it (watches its DMs / new container / MISC cards). Not "fully autonomous
  or bust" — autonomous discovery + a one-time manual add + ongoing maintenance.

## 2. Surfaces per company (where containers live)

| Company | Primary surfaces | Access |
|---|---|---|
| OSYX | OSYX Slack channels + MPIMs | `createSlackClientFromKeychain(_, "huizhezheng@gmail.com")` |
| 欧思克斯 (OUS) | WeChat groups (`@chatroom`) + high-freq customer/partner 1:1 DMs + the cross-company OSYX channels (OUS = commercial side of xEV/Leap/Chu/cascading/arm) | `wechatHistory`/`get_contacts`/`get_recent_sessions` + OSYX Slack |
| Taiv | Taiv Slack channels + Jira (TF board) + Gmail threads/labels | Slack MCP + Jira MCP + Gmail |

Cross-company is real and first-class: xEV / LeapMotor / Chu / cascading / robotic-arm
are OUS-commercial + OSYX-dev. A project has a primary `company` + an optional
`cross_company` list; it can be discovered from either surface and merged.

## 3. Pipeline (project-bootstrap)

1. **Enumerate** — per surface, list every container + last-activity ts + member/topic.
2. **Filter to live & project-like** — drop infra (`*-notifs`, `social`, `all-*`,
   公众号/`gh_`), drop dormant (no activity in `--dormant-weeks`, default 6), keep
   customer/partner/demo/topic containers. Borderline → keep, let summarize decide.
3. **Summarize each container** — pull a RECENT, DEEP window (newest-anchored, NOT
   oldest-first — the 古龙换汇 staleness lesson; ≥ enough messages to capture the real
   technical/commercial detail, not a shallow skim). Feed to `claude -p` with the
   Project schema → `{name, goal, current_state, needs[], blockers[], people[],
   money, stage}`. Evidence-grounded: state ONLY what the records show; "unknown" when
   not stated; NEVER promote "scheduled" to "done" (the LeapMotor-trip fabrication
   lesson).
4. **Cross-surface merge** — `claude -p` dedup over all summaries: the same project
   across containers/surfaces (xEV = OSYX `#renesas-1` + WeChat 京瓷 battery; Chu =
   `#chu-zh-rk3588` + WeChat Chu军工 + the joao/sandro MPIM) → one Project, union
   people/needs, canonical name. Title-keyed, like `tasks.ts dedupTaskMints`.
5. **Residual + MISC (L2/L3)** — `claude -p` over un-contained DMs/general channels +
   recurring MISC card clusters → emergent container-less candidates.
6. **Write + review** — staged YAMLs to `projects/_staged/` + a `_DISCOVERY-REVIEW.md`
   diff (new / changed / dormant vs the current live set). Leo reviews, edits, then
   `promote` moves them live (same gate as persona-bootstrap).

## 4. Accuracy rules (the manual-dig lessons, encoded)

- Container = project (don't keyword-guess; trust the human-made boundary).
- Read RECENT + DEEP (shallow window = generic mush; depth = the per-core CPU /
  amount / blocker detail that actually decides the Action Item).
- Merge across surfaces (one project spans Slack + WeChat).
- NEVER fabricate status. Only what's in the records. "scheduled" ≠ "done".
- Money / stage / blocker are first-class (they drive the next action).
- Human-in-the-loop staged → promote before it goes live.

## 5. Schema additions (relay/core/project.ts)

`Project` gains (all optional, back-compat): `company` (exists), `cross_company?:
string[]`, `containers?: {surface, id, name}[]` (provenance — which channels/groups
this project was built from), `stage?` (e.g. exploring / SoW / signed / delivering /
done), `money?` (string, e.g. "70k EUR" / "20k USD phase-1"), `status?` (active /
dormant / archived), `last_seen?` (ISO — newest evidence ts, for dormancy).

## 6. Self-maintenance loop

Re-run on a cadence (weekly) or incrementally:
- New container appears → new candidate project (review).
- Container silent > `--dormant-weeks` → mark `dormant`; long-silent → `archived`.
- An emergent (container-less) project that later grows a container → the merge pass
  auto-links the container into the existing project (no duplicate).
- Recurring MISC clusters → new candidates each run.
The project set maintains itself; Leo only reviews diffs.

## 7. Build

- `scripts/project-bootstrap.ts` — the deterministic pipeline (enumerate → window →
  `claude -p` summarize + merge → staged YAMLs + review doc). Resumable via stage
  files under `projects/_staged/_discovery/`. Zero API (reuses
  `createClaudeCliJsonCaller`). `--company ous|osyx|taiv`, `--dormant-weeks N`,
  `--stage enumerate|summarize|merge|write`, `--promote`.
- `.claude/skills/project-bootstrap/SKILL.md` — thin wrapper so Leo can invoke it +
  it documents the staged→review→promote gate. Separately invokable ONLY; never in
  the scan loop.

First run target: **OUS** (WeChat groups + cross-company OSYX channels). Validate the
staged output against the 2026-06-28 manual dig (xEV / LeapMotor / cascading / Chu /
robotic-arm) before wiring the OSYX-only and Taiv surfaces.
