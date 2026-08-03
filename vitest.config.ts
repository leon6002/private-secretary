import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Keep vitest scoped to this working tree's source. .claude/worktrees/* are
// git worktrees on parallel branches (e.g. wechat-cli-bootstrap) — their
// tests live in their own checkout and shouldn't run here.
//
// .tsx is included for the cockpit React app (relay/cockpit/web); its tests
// opt into jsdom per-file via a `// @vitest-environment jsdom` docblock, so
// the Node-side tests see no environment change.
export default defineConfig({
  // Resolve the cockpit web app's "@" alias (components import @/lib/cn etc.)
  // so its jsdom tests build like the app does.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./relay/cockpit/web/src", import.meta.url)) },
  },
  test: {
    include: ["relay/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".claude/worktrees/**"],
  },
});
