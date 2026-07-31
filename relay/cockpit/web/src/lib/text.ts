// Text helpers — verbatim ports of legacy public/js/state.js's isChinese() and
// clip(). isChinese drives the font-chinese class (IBM Plex Sans SC) on any
// string that contains CJK characters; clip collapses whitespace and truncates
// with an ellipsis for teaser text (role chips, goals, project state).

export function isChinese(s: string | null | undefined): boolean {
  return /[一-鿿]/.test(s || "");
}

export function clip(s: unknown, n: number): string {
  const str = String(s || "").replace(/\s+/g, " ").trim();
  return str.length > n ? str.slice(0, n) + "…" : str;
}
