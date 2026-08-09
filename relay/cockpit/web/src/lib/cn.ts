// cn() — the shadcn/ui convention for composing conditional Tailwind classes:
// clsx handles the conditional logic, tailwind-merge resolves conflicts
// (later class wins, e.g. cn("p-2", "p-4") → "p-4") so callers can override
// a component's defaults without fighting specificity.
//
// twMerge MUST be told about this project's type scale. Out of the box it only
// knows Tailwind's stock font sizes, so it read `text-label-sm` as a text
// COLOUR and dropped it in favour of whatever colour followed:
//
//   cn("text-label-sm", "text-on-surface-variant")  →  "text-on-surface-variant"
//
// Silent, and wrong everywhere the two are combined — the element just
// inherited 14px/400 instead of its 12px/500. Registering the scale under the
// font-size group is what makes size and colour independent again.
// Keep this list in sync with theme.extend.fontSize in tailwind.config.js.
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

export const TYPE_SCALE = [
  "display",
  "headline",
  "label-xs",
  "label-sm",
  "body-medium",
  "body-base",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_SCALE] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
