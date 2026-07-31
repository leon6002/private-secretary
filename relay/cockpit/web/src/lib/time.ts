// timeAgo — verbatim port of legacy public/js/state.js's helper ("just now",
// "5 min ago", "3h ago", "2d ago"). Used by the Activity tab; later screens
// (Queue timestamps) will want it too.
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
