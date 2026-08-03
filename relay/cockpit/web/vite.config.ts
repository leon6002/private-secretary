// Vite config for the cockpit React app (relay/cockpit/web). Invoked from the
// repo root via `npm run cockpit:build` / `npm run cockpit:dev` (both pass this
// directory as the vite root), so outDir is relative to here.
//
// Dev proxy: the cockpit API server (relay/cockpit/server.ts) binds
// 127.0.0.1:4317 and validates the Host header against its bound port
// (relay/cockpit/security.ts) — changeOrigin rewrites Host so proxied /api
// requests pass that check while the SPA itself is served by vite dev.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // shadcn/ui components import via "@/…" — map it to this app's src.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    // Served by relay/cockpit/server.ts as the static root; hashed assets land
    // in dist/assets and get immutable caching there.
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
});
