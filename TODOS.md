# TODOS

## Design debt

- [ ] **Mobile approval view (Phase 2.5)**
  - **What:** Single-column mobile Queue: enlarged routing line, ≥44px
    thumb-reach approve/edit/skip, swipe replaces j/k.
  - **Why:** Leo approves cards from the field (installs, trips — Chicago
    Jun 16-17 is typical). Desktop-first was a declared choice (design review
    2026-06-11, decision 18A), not an omission.
  - **Pros:** master-detail layout collapses to single column without rework;
    card semantics carry over 1:1.
  - **Cons:** new viewport to design + test; only valuable after the Phase 2
    desktop cockpit exists.
  - **Context:** specs/phase2-cockpit-design.md Pass 6; DESIGN.md tokens apply.
  - **Depends on:** Phase 2 desktop cockpit shipped.
