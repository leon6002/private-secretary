---
name: git-workflow
description: Git operations guide for this repo — the mandatory <type>(<scope>) + sign-off commit format, the allowed type/scope vocabulary, the two-remote push order (personal fork first, upstream only after functional testing), and rebasing with intelligent conflict resolution. Use whenever committing, pushing, rebasing a feature branch, or resolving merge conflicts here. Don't use for merge-commit workflows or initial repository setup.
metadata:
  rebase-section-author: Pedro Nauck
  rebase-section-source: https://github.com/pedronauck/skills
---

# Git operations guide (private-secretary)

Two halves, used at different moments:

- **[Committing and pushing](#committing-and-pushing)** — every commit. Project law.
- **[Rebasing and conflicts](#rebasing-and-conflicts)** — only when syncing a
  branch or untangling conflicts.

---

# Committing and pushing

`CLAUDE.md` mandates this format, so it overrides generic Conventional Commits
habits wherever the two disagree.

## Message format

```text
<type>(<scope>): <short summary>

<detailed explanation — what changed, why, and any trade-offs>

Signed-off-by: <git user.name> <git user.email>
```

The sign-off always uses the repo's real identity — read it, never hardcode it:

```bash
printf 'Signed-off-by: %s <%s>\n' "$(git config user.name)" "$(git config user.email)"
```

**Never** add a Claude co-author line (`Co-authored-by: Claude …`) or any other
AI attribution trailer. This is the one rule with zero exceptions.

Write the message through a file or heredoc, not `-m` fragments, so the body
survives intact:

```bash
git commit -F - <<'MSG'
fix(scope): summary line

Body explaining what and why.

Signed-off-by: Name <email>
MSG
```

## Types

Exactly these seven are used here:

| type | use for |
| --- | --- |
| `feat` | new feature or demo |
| `fix` | bug fix |
| `refactor` | no behaviour change |
| `docs` | documentation |
| `build` | build system / env |
| `chore` | tooling, .gitignore |
| `test` | tests |

Conventional Commits also defines `style`, `perf`, and `ci`. This repo does not
use them — map to the nearest of the seven (`style`/`perf` → `refactor`,
`ci` → `build` or `chore`).

## Scope

The affected area, lowercase. Established scopes, from actual history:

`cockpit` · `relay/core` · `io` · `scan` · `llm` · `draft` · `tasks` · `slack` ·
`executors` · `activity-log` · `scripts` · `skills` · `claude` · `agents` ·
`proc` · `web` · `cli` · `docs` · `test`

Prefer an existing scope over inventing one. Check before you guess:

```bash
git log --format='%s' | grep -oE '^[a-z]+\([^)]+\)' | sort | uniq -c | sort -rn
```

## Subject and body

- Imperative or descriptive present tense, lowercase start, no trailing period.
- One line. Aim for ≤ 72 chars; real history runs 31–91, so treat 72 as a target
  and ~90 as the ceiling, not the 50-char Conventional Commits suggestion.
- Body wraps at ~72 chars, separated from the subject by a blank line.
- The body explains **what changed and why**, plus trade-offs — not how. If a
  fix was subtle, say what the wrong behaviour was, so the commit reads as the
  bug report too.
- Footers when relevant: `Fixes #123`, `BREAKING CHANGE: …`. The sign-off is
  always last.

## Two-remote push order

This checkout tracks two GitHub remotes:

| remote | repo | role |
| --- | --- | --- |
| `fork` | `leon6002/private-secretary` | the owner's personal fork — **push here first** |
| `origin` | `LeoTaivDev/private-secretary` (redirects to `noobsplzwin/private-secretary`) | upstream — **push only after basic functionality testing** |

Despite `origin` being the conventional name for upstream, the day-to-day flow
is fork-first:

1. Commit on the working branch (`dev` — `main` is still the initial commit).
2. `git push fork dev` — publish to the personal fork.
3. Test basic functionality (`npm test`, `npm run typecheck`, and exercise the
   actual change — the installer, the cockpit, whatever it touched).
4. Only once that passes: `git push origin dev`.

So `fork/dev` is normally **ahead of** `origin/dev`. That gap is the workflow
working, not drift to be "fixed" — never fast-forward `origin` just to close it.

Verify the mapping before pushing on an unfamiliar machine; remote names are
local, not intrinsic:

```bash
git remote -v
git log --oneline --graph --decorate fork/dev origin/dev -5
```

**Both remotes were public as of 2026-08-09.** Neither is a safe place for
secrets, tokens, or customer data, regardless of which one is "mine".

## Never push unasked

Commit when the work is done; push only when the user asks. Pushing is
outward-facing and hard to reverse — approval for one push does not carry to the
next. The same goes for anything that rewrites published history: always
`--force-with-lease`, never `--force`.

## Commit workflow

1. `git status` and `git diff` (plus `git diff --staged`) to see the real change.
2. Group unrelated changes into separate commits rather than one grab-bag.
3. Pick `type` and `scope` from the vocabularies above.
4. Stage explicitly — name the paths, avoid a blind `git add -A` that sweeps in
   scratch files, `state/`, or personas.
5. Commit via heredoc with the sign-off.
6. Report the short SHA. Stop there unless a push was requested.

---

# Rebasing and conflicts

## Quick start

For most rebases with multiple commits, squash first so conflicts resolve once:

```bash
bash scripts/pre-rebase-backup.sh                      # 1. backup
git rebase -i $(git merge-base HEAD origin/main)       # 2. squash
git rebase origin/main                                 # 3. rebase onto target
# 4. resolve conflicts once, then: git rebase --continue
git push origin $(git rev-parse --abbrev-ref HEAD) --force-with-lease
```

Note: with two remotes here, rebase onto whichever you actually track —
`origin/dev` is the usual target, not `origin/main`.

## Workflow

```
- [ ] 1. Create safety backup
- [ ] 2. Fetch latest from target branch
- [ ] 3. Analyze conflict scope
- [ ] 4. Choose resolution strategy
- [ ] 5. Apply conflict resolutions
- [ ] 6. Validate merged code
- [ ] 7. Run tests
- [ ] 8. Force push safely
```

### 1. Safety backup

ALWAYS first. Costs nothing, saves hours:

```bash
bash scripts/pre-rebase-backup.sh
# or: git branch backup-rebase-$(date +%Y%m%d_%H%M%S)
```

### 2. Fetch and see the divergence

```bash
git fetch origin
git log --oneline origin/dev..HEAD   # your commits
git log --oneline HEAD..origin/dev   # new commits upstream
```

### 3. Predict conflicts

```bash
git diff --name-only origin/dev...HEAD   # files you changed
git diff --name-only origin/dev HEAD     # files upstream changed
```

Files in both lists WILL conflict.

### 4. Choose a strategy

| strategy | when | trade-off |
| --- | --- | --- |
| **A. Squash first** (recommended, 3+ commits) | many commits, conflicts expected | one resolution pass; loses individual commit history |
| **B. Interactive** | 1–2 commits, or per-commit logic matters | more control, more iterations |
| **C. Plain `git rebase`** | simple cases, automation | fastest; not for complex scenarios |

Full comparison and decision matrix: [references/strategies.md](references/strategies.md).

### 5. Resolve conflicts

```bash
bash scripts/analyze-conflicts.sh
git status
git mergetool --no-prompt      # or edit markers by hand
```

Before deleting any conflict marker, answer in order:

1. **Can you keep both?** Usually yes — merge them intelligently.
2. **Genuinely conflicting logic?** Understand WHY they differ first. Upstream
   security checks win; your feature's essential behaviour stays.
3. **Would a feature silently disappear?** Never let that happen.

✅ Keep both sides' important functionality · comment non-obvious merges ·
test each resolved file.
❌ Don't pick a side without reading both · don't leave duplicated code · don't
skip testing before `--continue`.

Patterns and heuristics: [references/resolution-patterns.md](references/resolution-patterns.md).

### 6–7. Validate and test

```bash
bash scripts/validate-merge.sh
npm run typecheck
npm test
```

**Never force-push code that fails tests.** In this repo that includes the
mandatory regression tests named in `CLAUDE.md` — if a rebase drops
`dedup-survives-restart`, `no-double-execute`, `reply-requires-approval`,
`R1-manual-survives-llm-update`, or `round-commit-without-task_id-unchanged`,
the resolution is wrong, not the test.

### 8. Force push safely

```bash
git push fork $(git rev-parse --abbrev-ref HEAD) --force-with-lease
```

`--force-with-lease` refuses to overwrite commits you haven't seen; `--force`
does not. If the lease fails, someone pushed — coordinate, don't override. Per
the push order above, a rewritten branch goes to `fork` first and only reaches
`origin` after testing.

## Common scenarios

- **Many small conflicts across 5+ commits** → squash first (Strategy A); one
  resolution pass instead of one per commit.
- **One specific commit conflicts** → `git rebase -i`, move it last to isolate it.
- **Same conflict repeating across commits** → `git config --global rerere.enabled true`;
  git replays your first resolution.
- **Too complex** → `git rebase --abort`, then `git merge origin/dev` instead.
  Aborting and rethinking beats a broken rebase.

More: [references/troubleshooting.md](references/troubleshooting.md) ·
[references/automation.md](references/automation.md) ·
[references/scripts-tools.md](references/scripts-tools.md)

## When NOT to rebase

Shared branches · critical production code without tests · multiple people
pushing to the same branch · conflicts you don't understand.

**Default to merge if uncertain.** Rebase when it's a solo feature branch and
clean history matters.

## Bundled scripts

`scripts/pre-rebase-backup.sh` · `scripts/analyze-conflicts.sh` ·
`scripts/validate-merge.sh` — run with `bash scripts/<name>.sh`.

---

`CLAUDE.md` → "Git commit convention" is the source of truth for the message
format. If the two ever disagree, `CLAUDE.md` wins and this skill needs updating.
