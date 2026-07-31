// Avatar — the React port of legacy public/js/state.js's avatar(): a colored
// initials chip keyed by a stable hue, with an optional head photo (Slack /
// WeChat, resolved by scripts/resolve-avatars.ts) layered on top.
//
// Two-layer behavior is verbatim legacy: the initials chip is always the base;
// the photo overlays it and fills the circle. If the photo URL fails, legacy's
// onerror removed the <img> and the initials showed through — here the failed
// URL is remembered in state and the <img> unmounts instead (removing the DOM
// node behind React's back, like the legacy handler did, can make a later
// reconciliation throw). The hue lives in an inline hsl() style, not a token,
// on purpose: it is a per-contact identity color (the SAME hue in both themes,
// so a contact is the same color on every screen), not theme chrome.
import { useState } from "react";

export interface AvatarProps {
  label: string; // display name — initials source + hue fallback
  hueKey?: string; // persona key; keeps one contact's hue stable across renames
  size?: number; // px, default 24 (legacy default)
  photo?: string; // head-photo URL, optional
}

// Verbatim legacy hueFromKey: iterate UTF-16 code UNITS (an indexed loop, not
// for…of, which would iterate code points and diverge on astral characters).
// The People and Projects screens must agree on a contact's color, so this
// algorithm is a contract — do not "improve" it.
export function hueFromKey(key: string): number {
  const s = key || "?";
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ label, hueKey, size = 24, photo }: AvatarProps) {
  // URL-keyed, not a boolean: a NEW photo URL after a failure must get its own
  // chance to load (legacy re-rendered the <img> from scratch).
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const initials = (label || "?").trim().slice(0, 2).toUpperCase();
  const hue = hueFromKey(hueKey || label);
  return (
    <span
      className="relative overflow-hidden inline-flex items-center justify-center rounded-full text-white font-semibold text-[10px] flex-shrink-0"
      style={{ width: size, height: size, background: `hsl(${hue} 45% 45%)` }}
    >
      {initials}
      {photo && photo !== failedUrl && (
        <img
          src={photo}
          alt=""
          className="absolute inset-0 w-full h-full object-cover rounded-full"
          // onerror="this.remove()" in legacy: drop the photo, keep initials.
          onError={() => setFailedUrl(photo)}
        />
      )}
    </span>
  );
}
