// Slack's wire format is not what a person reads. A message arrives as
//
//   Hi <@U08M6C96P2P>, see <https://example.com/x|example.com/x>
//
// and printing it verbatim shows a user id nobody can identify and a URL
// duplicated inside angle brackets. Both were visible in the cockpit.
//
// This resolves the parts that need a lookup (user mentions) and unwraps the
// parts that are pure syntax (links, channels). It runs where the name cache
// lives — the reader — because the UI has no way to turn U08M6C96P2P into a
// person.

/** Every user id referenced by a <@Uxxx> mention, so they can be resolved in one pass. */
export function mentionedUserIds(text: string): string[] {
  return [...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
}

/**
 * Rewrite Slack wire syntax into what the message says.
 * - `<@U123>` → `@Name` when known, else `@U123` (never a bare id)
 * - `<#C123|general>` → `#general`
 * - `<https://x|label>` → `label`; `<https://x>` → `https://x`
 * - `<!here>` / `<!channel>` → `@here` / `@channel`
 */
export function renderSlackText(text: string, names: ReadonlyMap<string, string>): string {
  return text
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
