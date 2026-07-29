# personas/ — per-contact profiles (NOT committed)

Each contact gets one YAML file here, following the v3 schema in
`specs/persona-v3.md`. The engine reads them to ground its analysis: who this
person is, what they own, how they write, what they have committed to.

## Why this directory is gitignored

A persona is a detailed, opinionated dossier on a real colleague — their role,
their reliability, their communication quirks, their "landmines", sometimes
personal context. It is written *about* them, not *by* them. Publishing that,
even to a private repo, means the people described can read your private notes
on them. So: **personas never leave the machine that generated them.**

`personas/_example/` holds one FABRICATED profile so you can see the shape.

## Getting your own

Run the one-time bootstrap (see `.claude/skills/persona-bootstrap/SKILL.md`):
it reads your own message history and writes profiles into `personas/_staged/`
for review, then a separate promote step moves them live. It is never part of
the scan loop.

Until you have personas, the engine still runs — it just has no sender context,
so its analysis is much weaker. Start with your 5–10 most frequent contacts.
