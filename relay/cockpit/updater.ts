// One-click update for the installed copy.
//
// Re-running the installer in a terminal is fine for us and useless for a
// customer: the product's whole premise is that nothing requires a shell. This
// is the same four steps the installer does — pull, install, build, restart —
// driven from the cockpit and reported back.
//
// Two things it deliberately will NOT do:
//
// 1. Never `git reset --hard`. If the checkout has local changes the update
//    stops and says so. Discarding a user's edits to get an update through
//    trades a small inconvenience for silent data loss.
// 2. Never restart in the same request that builds. The cockpit is one of the
//    processes being restarted, so it would be killing the connection it is
//    answering on — the browser would see a dropped request and could not tell
//    success from crash. Build and restart are separate calls, and the UI
//    confirms by watching the reported commit change.

import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const AGENT_LABELS = ["tv.taiv.secretary", "tv.taiv.secretary.cockpit"] as const;

export type Runner = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRunner: Runner = async (file, args) =>
  execFileAsync(file, args, { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024 });

async function git(runner: Runner, ...args: string[]): Promise<string> {
  return (await runner("git", args)).stdout.trim();
}

export interface UpdateStatus {
  /** Short sha of what is running. */
  current: string;
  currentSubject: string;
  /** Short sha available upstream, after a fetch. */
  latest: string;
  behind: number;
  /** Uncommitted changes in the checkout — blocks updating. */
  dirty: boolean;
  branch: string;
  /** Set when the status itself could not be determined. */
  error?: string;
}

export async function updateStatus(runner: Runner = defaultRunner): Promise<UpdateStatus> {
  try {
    const branch = await git(runner, "rev-parse", "--abbrev-ref", "HEAD");
    const dirty = (await git(runner, "status", "--porcelain")).length > 0;
    const current = await git(runner, "rev-parse", "--short", "HEAD");
    const currentSubject = await git(runner, "log", "-1", "--format=%s");
    // Fetch so "behind" reflects the remote, not a stale ref.
    await runner("git", ["fetch", "--quiet", "origin", branch]).catch(() => ({ stdout: "" }));
    const latest = await git(runner, "rev-parse", "--short", `origin/${branch}`).catch(() => current);
    const behindRaw = await git(runner, "rev-list", "--count", `HEAD..origin/${branch}`).catch(
      () => "0",
    );
    return { current, currentSubject, latest, behind: Number(behindRaw) || 0, dirty, branch };
  } catch (e) {
    return {
      current: "",
      currentSubject: "",
      latest: "",
      behind: 0,
      dirty: false,
      branch: "",
      error: e instanceof Error ? e.message.split("\n")[0]! : String(e),
    };
  }
}

export interface UpdateRun {
  ok: boolean;
  from: string;
  to: string;
  /** Human-readable step log, shown in the UI so a failure is diagnosable. */
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  /** True when a restart is needed to run what was just built. */
  needsRestart: boolean;
}

export async function runUpdate(runner: Runner = defaultRunner): Promise<UpdateRun> {
  const steps: UpdateRun["steps"] = [];
  const before = await updateStatus(runner);
  if (before.error) {
    return { ok: false, from: "", to: "", needsRestart: false, steps: [{ step: "inspect", ok: false, detail: before.error }] };
  }
  if (before.dirty) {
    return {
      ok: false,
      from: before.current,
      to: before.current,
      needsRestart: false,
      steps: [
        {
          step: "check",
          ok: false,
          detail:
            "The install has uncommitted changes. Updating would discard them, so it stopped instead.",
        },
      ],
    };
  }
  if (before.behind === 0) {
    return {
      ok: true,
      from: before.current,
      to: before.current,
      needsRestart: false,
      steps: [{ step: "check", ok: true, detail: "Already up to date." }],
    };
  }

  // --ff-only, never a merge or a reset: if history diverged, stop and say so
  // rather than inventing a resolution on a machine nobody is watching.
  const plan: Array<[string, string, string[]]> = [
    ["pull", "git", ["pull", "--ff-only"]],
    ["dependencies", "npm", ["install", "--no-fund", "--no-audit"]],
    ["build", "npm", ["run", "cockpit:build"]],
  ];
  for (const [step, file, args] of plan) {
    try {
      await runner(file, args);
      steps.push({ step, ok: true });
    } catch (e) {
      steps.push({
        step,
        ok: false,
        detail: e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ") : String(e),
      });
      // Stop at the first failure. Restarting onto a half-applied update is
      // how a working install becomes a broken one.
      return { ok: false, from: before.current, to: before.current, steps, needsRestart: false };
    }
  }
  const after = await updateStatus(runner);
  return { ok: true, from: before.current, to: after.current, steps, needsRestart: true };
}

// Restart both agents. Detached on purpose: this process is one of them, so it
// must not wait on a command that will kill it.
export function restartServices(spawnFn: (file: string, args: string[]) => void): void {
  const uid = process.getuid?.() ?? 0;
  for (const label of AGENT_LABELS) {
    spawnFn("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
  }
}
