// Slack's wire format is not what a person reads. A message arrives as
//
//   Hi <@U08M6C96P2P>, see <https://example.com/x|example.com/x>
//
// and printing it verbatim shows a user id nobody can identify and a URL
// duplicated inside angle brackets. Both were visible in the cockpit.
//
// This resolves the parts that need a lookup (user mentions) and unwraps the
// parts that are pure syntax (links, channels, emoji). It runs where the name
// cache lives — the reader — because the UI has no way to turn U08M6C96P2P
// into a person.

import { EMOJI_SHORTCODES } from "./emoji-shortcodes.js";

/** Every user id referenced by a <@Uxxx> mention, so they can be resolved in one pass. */
export function mentionedUserIds(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
}

/**
 * Replace `:shortcode:` with the emoji it stands for.
 *
 * Unknown names are left alone rather than dropped: a workspace's custom emoji
 * (`:taiv-logo:`) has no Unicode equivalent, and `:30:` inside a timestamp is
 * not an emoji at all. Leaving them costs a few visible colons; removing them
 * would silently delete part of the message.
 *
 * A trailing `:skin-tone-N:` is dropped instead of rendered, because on its own
 * the modifier is a meaningless colour swatch — Slack only ever sends it
 * attached to the emoji before it.
 *
 * The lookbehind keeps URLs intact. `example.com/a:b:c` contains what looks
 * like `:b:`, and `b` really is an emoji name (🅱️) — without it, pasting a
 * link with a port or a path segment would rewrite the link.
 */
function renderEmoji(text: string): string {
  return text.replace(/(?<![\w/]):([a-z0-9_+-]+):/gi, (m, name: string) => {
    const key = name.toLowerCase();
    if (/^skin-tone-[2-6]$/.test(key)) return "";
    return EMOJI_SHORTCODES[key] ?? m;
  });
}

/**
 * Rewrite Slack wire syntax into what the message says.
 * - `<@U123>` → `@Name` when known, else `@U123` (never a bare id)
 * - `<#C123|general>` → `#general`
 * - `<https://x|label>` → `label`; `<https://x>` → `https://x`
 * - `<!here>` / `<!channel>` → `@here` / `@channel`
 * - `:joy:` → 😂
 */
export function renderSlackText(text: string, names: ReadonlyMap<string, string>): string {
  return renderEmoji(text)
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => {
      const name = names.get(id) || label;
      return name ? `@${name}` : `@${id}`;
    })
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) =>
      label ? `#${label}` : `#${id}`,
    )
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, k: string) => `@${k}`)
    // Links last: the patterns above are also <…>-delimited, so unwrapping
    // links first would eat them.
    .replace(/<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g, (_m, url: string, label?: string) =>
      label || url,
    );
}
