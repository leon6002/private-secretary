# DESIGN.md — secretary cockpit design system

Decided in /plan-design-review 2026-06-11. The DESIGN SYSTEM PREAMBLE below is
pasted VERBATIM at the top of every Stitch prompt (and later, every implemented
screen reads from these tokens). One source of truth; the five screens must
look like one product.

## Design system preamble (paste into every prompt)

```
DESIGN SYSTEM (identical across all screens of this app):
- Product wordmark: "secretary" lowercase, top of the left nav rail.
- Typography: IBM Plex Sans for Latin; IBM Plex Sans SC for Chinese — same
  family, bilingual text must look like one voice. Type scale: 22px page
  title / 15px section heading / 13.5px body / 12px meta. Body line-height
  1.6 (Chinese text needs the looser leading).
- Color: white surfaces on a #F7F7F8 canvas; slate text (#1A1D21 primary,
  #6B7280 secondary); hairline borders #E5E7EB — NO drop shadows anywhere,
  structure comes from borders and background tint zoning.
- One accent: cool blue #2563EB (primary buttons, selected states, links).
- Action-type tag colors (muted, low-saturation): reply blue, relay purple,
  forward teal, calendar green, task gray, brief slate. Amber is RESERVED
  exclusively for needs-info states. Staged/review banners use soft violet.
- Spacing: strict 8px grid; dense 8/12px inside cards, generous 24/32px
  between groups.
- Radius: 6px on cards and buttons, 4px on chips. One radius scale only.
- Cards: 1px hairline border, white fill. Cards exist ONLY where the card is
  the interaction unit (approval cards). Reference data uses definition
  lists/tables, not cards.
- Avatars: 24px (lists) / 32px (headers); no photo → initials on a circle,
  hue deterministically hashed from the contact; never stock photos.
- Language badges: text chips `EN` / `中文` — never flags.
- Banned: gradients, icons-in-colored-circles, centered text blocks,
  border-left accent stripes on cards, decorative blobs/waves, emoji as UI,
  drop shadows, Inter/Roboto/system-ui.
```

## Dark theme (amendment, 2026-07-31 — owner: 古龙)

Dark mode is no longer banned; it ships with the React cockpit. The original
light-only stance assumed a single token set; the React migration made every
color a CSS variable (`relay/cockpit/web/src/index.css`, `:root` light /
`.dark` dark), so dark is the same design with a second value column, not a
second design. The rules survive unchanged: hairline borders, no shadows,
structure from borders and tint zoning. Dark palette: canvas #0F1115,
surface #171A21, surface-variant #1E222B, outline #262B36, text #E6E8EC /
#9AA3B2 secondary, primary #3B82F6, error #F87171. Preference: follow the OS
by default, override in Settings → General (persisted locally).

## Component vocabulary

| Component | Spec |
|---|---|
| Left nav rail | 56px wide, icons: Queue / Projects / People / Connections / Settings, pending-count badge on Queue, wordmark on top |
| Task group header | full-width tinted band (#F1F2F4), title + people avatars + "2 of 4 done" + collapse |
| Approval card (selected) | routing line → original (expandable) → why + evidence chips → draft (read-only until [Edit]) → actions |
| Routing line | sender avatar+platform → recipient avatar+platform, action-type tag |
| Confidence | hidden when ≥0.8; below: "low confidence · 0.6" warning chip |
| Evidence popover | opens on CLICK from inferred badge; quote + date + platform + view-source |
| Provenance badges | manual = solid lock; inferred = dotted outline |
| Empty queue | quiet full-area "All handled." + auto-handled drawer centered + last-scan time |
| Drawer rows | every assistant-solo decision; [Restore to queue] on each |
| Motion | exactly one: approve slide-out. Nothing else moves |

## Voice (microcopy)

Calm, factual, slightly warm. Tells the truth about state: "nothing was sent",
"cursor frozen, nothing lost", "— not yet observed". Never celebratory noise,
never alarm theater. The Connections page tone ("by design") is the canonical
register for the whole product.
