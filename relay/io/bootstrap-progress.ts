// Bootstrap progress persistence: state/bootstrap-progress.json. Pure
// progress logic (init/mark/next) lives in relay/core/bootstrap.ts — this
// file is fs only, mirroring relay/io/state.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BootstrapProgress } from "../core/bootstrap.js";

export function loadProgress(path: string): BootstrapProgress | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as BootstrapProgress;
}

export function saveProgress(path: string, progress: BootstrapProgress): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(progress, null, 2), "utf8");
}
