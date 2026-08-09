---
name: git-commit
description: Commit and push rules for this repo — the mandatory <type>(<scope>) + sign-off message format, the allowed type/scope vocabulary, and the two-remote push order (personal fork first, upstream only after functional testing). Use whenever writing a commit message, committing changes, or pushing this project. Don't use for rebases or conflict resolution — that is the git-rebase skill.
---

# Git commit + push rules (private-secretary)

These rules are project law: `CLAUDE.md` mandates them, so they override generic
Conventional Commits habits wherever the two disagree.

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

Commit when the work is done; push only when the user asks for it. Pushing is
outward-facing and hard to reverse — approval for one push does not carry to the
next. Same for anything that rewrites published history (see the `git-rebase`
skill for the safe path, and always `--force-with-lease`, never `--force`).

## Workflow

1. `git status` and `git diff` (plus `git diff --staged`) to see the real change.
2. Group unrelated changes into separate commits rather than one grab-bag.
3. Pick `type` and `scope` from the vocabularies above.
4. Stage explicitly — name the paths, avoid a blind `git add -A` that sweeps in
   scratch files, `state/`, or personas.
5. Commit via heredoc with the sign-off.
6. Report the short SHA. Stop there unless a push was requested.

## Related

- `git-rebase` skill — rebasing, conflict resolution, force-push safety. Use it
  for history surgery; use this skill for authoring the message.
- `CLAUDE.md` → "Git commit convention" is the source of truth for the format.
  If the two ever disagree, `CLAUDE.md` wins and this skill needs updating.
