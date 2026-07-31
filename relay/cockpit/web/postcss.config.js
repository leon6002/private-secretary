// PostCSS pipeline for the cockpit web app (Tailwind v3 classic setup).
// ESM export because the repo root package.json is "type": "module".
//
// The tailwind config path is explicit: postcss-load-config finds THIS file
// via the CSS input, but tailwind itself would search for tailwind.config.js
// from process.cwd() — which is the repo root under `npm run cockpit:build`,
// not this directory.
import { fileURLToPath } from "node:url";

export default {
  plugins: {
    tailwindcss: {
      config: fileURLToPath(new URL("./tailwind.config.js", import.meta.url)),
    },
    autoprefixer: {},
  },
};
