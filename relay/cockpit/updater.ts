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
// 2. Never restart BEFORE answering. The cockpit is one of the processes being
//    restarted, so it would be killing the connection it is answering on — the
//    browser would see a dropped request and could not tell success from
//    crash. The response goes out first and the restart follows a beat later;
//    the page confirms by watching the reported commit change.

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
  /** Short sha the RUNNING process loaded. Only changes on a restart, which is
   *  what makes it usable as the "did the restart happen" signal — HEAD moves
   *  at pull time, so comparing HEAD could never detect a restart. */
  running: string;
  /** Short sha of the checkout. Ahead of `running` after a pull, before a restart. */
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

// The remote check costs a network round trip; the local part costs nothing.
// Fetching on every page load made the tab sit blank for seconds, so the fetch
// is cached and refreshed in the background — the page always paints the local
// state immediately and the remote figure catches up.
const REMOTE_TTL_MS = 5 * 60 * 1000;
let remoteCache: { at: number; branch: string; latest: string; behind: number } | null = null;
let fetching: Promise<void> | null = null;

export function _resetRemoteCache(): void {
  remoteCache = null;
  fetching = null;
}

async function refreshRemote(runner: Runner, branch: string, now: number): Promise<void> {
  await runner("git", ["fetch", "--quiet", "origin", branch]).catch(() => ({ stdout: "" }));
  const latest = await git(runner, "rev-parse", "--short", `origin/${branch}`).catch(() => "");
  const behind = Number(
    await git(runner, "rev-list", "--count", `HEAD..origin/${branch}`).catch(() => "0"),
  );
  remoteCache = { at: now, branch, latest, behind: behind || 0 };
}

// Captured once per process: the commit this code was loaded from. Taken at
// startup rather than lazily, because a lazy first read after a pull would
// record the NEW sha and the restart would look like it never happened.
let runningSha = "";
export async function captureRunningSha(runner: Runner = defaultRunner): Promise<void> {
  runningSha = await git(runner, "rev-parse", "--short", "HEAD").catch(() => "");
}
export function _setRunningShaForTest(sha: string): void {
  runningSha = sha;
}

export async function updateStatus(
  runner: Runner = defaultRunner,
  opts: { force?: boolean; now?: () => number } = {},
): Promise<UpdateStatus> {
  const now = (opts.now ?? Date.now)();
  try {
    const branch = await git(runner, "rev-parse", "--abbrev-ref", "HEAD");
    // --untracked-files=no is the whole point: a pull can only ever discard
    // MODIFICATIONS to tracked files. An untracked file — a scratch script, a
    // downloaded log — survives it untouched, so counting those as "dirty"
    // blocked updates to protect something that was never at risk. One stray
    // file in an install directory was enough to stop it updating for good.
    // (If an incoming commit does add a file at that same path, git refuses
    // the pull itself and the step reports it — caught where it is real.)
    const dirty = (await git(runner, "status", "--porcelain", "--untracked-files=no")).length > 0;
    const current = await git(runner, "rev-parse", "--short", "HEAD");
    const currentSubject = await git(runner, "log", "-1", "--format=%s");

    const fresh =
      remoteCache && remoteCache.branch === branch && now - remoteCache.at < REMOTE_TTL_MS;
    if (opts.force || !remoteCache || remoteCache.branch !== branch) {
      // First load, a branch switch, or an explicit check: worth waiting for.
      await refreshRemote(runner, branch, now);
    } else if (!fresh && !fetching) {
      // Stale: answer from cache now, refresh behind the response. A slow
      // network must not hold up a page that already knows what it is running.
      fetching = refreshRemote(runner, branch, now).finally(() => {
        fetching = null;
      });
    }
    const remote = remoteCache;
    return {
      running: runningSha || current,
      current,
      currentSubject,
      latest: remote?.latest || current,
      behind: remote?.behind ?? 0,
      dirty,
      branch,
    };
  } catch (e) {
    return {
      running: runningSha,
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
  const before = await updateStatus(runner, { force: true });
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
    // Up to date on disk is not the same as up to date in memory. A machine
    // that pulled but never restarted would otherwise sit on the old code
    // forever, with nothing left to click — so say a restart is still needed.
    const pending = !!before.running && before.running !== before.current;
    return {
      ok: true,
      from: before.current,
      to: before.current,
      needsRestart: pending,
      steps: [
        {
          step: "check",
          ok: true,
          detail: pending ? "Already downloaded — restarting to apply." : "Already up to date.",
        },
      ],
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
  const after = await updateStatus(runner, { force: true });
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
