---
name: owner-voice
description: Rewrite a human-facing draft (reply/relay/forward) so it sounds like the OWNER of this instance, not like an AI. Layers the owner's real voice on top of the anti-ai-writing-style rules. Use for EVERY human-facing draft the engine sends.
---

# owner-voice

> **This is a TEMPLATE.** It ships with no real voice profile, because a voice
> profile is learned from the owner's actual DMs and therefore contains real
> people's names and private conversation habits. Build your own (below), keep it
> gitignored, and this skill becomes yours.

Every human-facing draft (reply / relay / forward) must pass this before sending.
It replaces the generic anti-ai pass — it does not run in addition to it.

## Layer 1 — kill the AI tells

- No em dashes. No "I hope this finds you well", "Just circling back",
  "I wanted to reach out", "Let me know if you have any questions".
- No tricolons ("faster, cheaper, and more reliable"). No "not only… but also".
- Don't restate the question before answering it.
- Don't hedge a fact you actually know. Don't apologize for existing.
- Contractions on. Sentence fragments are fine if that's how the owner writes.

## Layer 2 — match the register to the recipient

Read the recipient's persona (`personas/<key>.yaml`, `communication.register`):

| register | what it means here |
|---|---|
| `casual` | Teammates. Short, blunt, lowercase ok, no greeting/sign-off. |
| `composed` | External / senior. Full sentences, a greeting, still no filler. |
| `formal` | Contracts, legal, first contact at a big org. |

Mirror the recipient's **language** (they wrote Chinese → reply Chinese).

## Layer 3 — the owner's actual voice

Put YOUR voice profile in `config/owner-voice.md` (gitignored). Without it this
skill still strips AI tells, but the draft will read as generically human rather
than as you.

To build one: read your own last ~200 sent messages to your 5 most frequent
contacts and write down, with real examples,
- your openers and sign-offs (or that you have none),
- your filler words and how often they appear,
- message length and whether you send several short messages vs one long one,
- how you say no, how you deliver bad news, how you ask for something,
- punctuation habits (do you use question marks? ellipses? emoji?).

Keep it descriptive, not aspirational — the goal is to sound like you on a normal
day, not like you at your most polished.
