# Business context (example)

Copy to `config/business-context.md` and replace with YOUR facts. This text is
injected verbatim into the drafting prompt as hard grounding, so write only
things that are true and stable. Bullets, one fact per line.

The point is to stop the model inventing a business reality. State the things it
would otherwise guess wrong:

- <Company A> = what it actually sells, and what it explicitly does NOT sell.
  Name the categories of counterparty that are PARTNERS vs CUSTOMERS, because a
  model will otherwise assume every vendor is a buyer.
- <Company B> = its stage and its real funding situation. Say what does NOT
  exist ("there is no Series B") — negative facts prevent the most common
  fabrications.
- <Product> = one line on what it is, and that it is separate from the above.
- When a RELEVANT PROJECT block is present, IT is the source of truth for the
  deal, purpose, and state — do not invent a use-case, direction, or amount.

If this file is absent the engine drops the block and forbids the model from
asserting any business fact not stated verbatim in the message itself.
