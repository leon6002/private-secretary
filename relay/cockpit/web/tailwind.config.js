// Tailwind v3 config (classic config + postcss pipeline — not the v4 CSS-first
// style). The color palette maps semantic names onto CSS variables defined in
// src/index.css (:root light / .dark dark), so components keep the legacy
// vanilla-SPA class semantics (bg-surface, border-outline, text-on-surface…)
// and theme switching needs no dark: variants — the variables flip underneath.
//
// content paths are ABSOLUTE on purpose: tailwind resolves relative globs
// against process.cwd(), but `npm run cockpit:build` runs from the repo root
// while `vite dev` may run from here — anchoring to this file keeps both right.
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  // class strategy: src/lib/theme.tsx toggles .dark on <html>.
  darkMode: "class",
  content: [`${here}index.html`, `${here}src/**/*.{ts,tsx}`],
  theme: {
    extend: {
      colors: {
        primary: "rgb(var(--primary) / <alpha-value>)",
        background: "var(--background)",
        surface: "var(--surface)",
        "surface-variant": "var(--surface-variant)",
        outline: "var(--outline)",
        "on-surface": "var(--on-surface)",
        "on-surface-variant": "var(--on-surface-variant)",
        error: "var(--error)",
      },
      borderRadius: { DEFAULT: "6px", lg: "6px", xl: "11px", sm: "4px" },
      fontFamily: {
        sans: ["'IBM Plex Sans'", "sans-serif"],
        chinese: ["'IBM Plex Sans SC'", "sans-serif"],
      },
      // Same type scale as the legacy CDN tailwind config (DESIGN.md).
      fontSize: {
        display: ["20px", { lineHeight: "28px", letterSpacing: "-0.01em", fontWeight: "600" }],
        headline: ["18px", { lineHeight: "28px", letterSpacing: "-0.01em", fontWeight: "500" }],
        "label-xs": ["11px", { lineHeight: "14px", letterSpacing: "0.05em", fontWeight: "600" }],
        "label-sm": ["12px", { lineHeight: "16px", fontWeight: "500" }],
        "body-medium": ["14px", { lineHeight: "20px", fontWeight: "500" }],
        "body-base": ["14px", { lineHeight: "20px", fontWeight: "400" }],
      },
    },
  },
  plugins: [],
};
