---
paths:
  - "personas/**"
  - "relay/io/persona*"
  - "relay/core/persona*"
  - "relay/proc/persona*"
  - ".claude/skills/persona-bootstrap/**"
---

# Persona layer (specs/persona-v3.md)

- Every LLM write goes through the persona-store chokepoint
  (`relay persona-write <file> llm`). Provenance `manual` fields are NEVER
  overwritten by the LLM.
- Every inferred field carries evidence. No evidence → leave the field empty.
  **Sparse personas are correct**; invented ones are not.
- Style profiles rebuild only on explicit user command. Persona merges only via
  an approved card.
- `/persona-bootstrap` is a ONE-TIME batch job — never part of the scan loop,
  never triggered automatically. Output is staged to `personas/_staged/`; a
  separate promote step goes live.
- New contact with no persona → build a profile first from the broadest context
  available (Slack search, Gmail, employee directory, referenced Jira/Notion).
  Never draft for a stranger off a single message.

Mandatory regression test, never delete: `R1-manual-survives-llm-update`
(persona-v3.test.ts).
