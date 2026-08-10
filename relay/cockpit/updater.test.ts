import { describe, expect, it } from "vitest";
import { beforeEach } from "vitest";
import {
  AGENT_LABELS,
  _resetRemoteCache,
  _setRunningShaForTest,
  restartServices,
  runUpdate,
  updateStatus,
  type Runner,
} from "./updater.js";

function fakeGit(over: Record<string, string> = {}, fail?: string): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (file, args) => {
    calls.push([file, ...args]);
    if (fail && `${file} ${args[0]}`.startsWith(fail))
      throw new Error([`${fail} exploded`, "line2", "line3", "TAIL_NOISE"].join("\n"));
    const key = args.join(" ");
    for (const [k, v] of Object.entries(over)) if (key.startsWith(k)) return { stdout: v };
    return { stdout: "" };
  };
  return { runner, calls };
}

const CLEAN = {
  "rev-parse --abbrev-ref": "dev",
  "status --porcelain": "",
  "rev-parse --short HEAD": "aaa1111",
  "log -1": "some commit",
  "rev-parse --short origin/dev": "bbb2222",
  "rev-list --count": "3",
};

beforeEach(() => {
  _resetRemoteCache();
  _setRunningShaForTest("");
});

describe("updateStatus", () => {
  it("fetches before reporting how far behind it is", async () => {
    const { runner, calls } = fakeGit(CLEAN);
    const s = await updateStatus(runner);
    expect(s).toMatchObject({ current: "aaa1111", latest: "bbb2222", behind: 3, dirty: false });
    expect(calls.some((c) => c[1] === "fetch")).toBe(true);
  });

  // A machine with no git, or a broken checkout, must not take the UI down.
  it("reports an error instead of throwing", async () => {
    const { runner } = fakeGit({}, "git rev-parse");
    expect((await updateStatus(runner)).error).toBeTruthy();
  });
});

// A pull discards local MODIFICATIONS, never untracked files — so the dirty
// check has to ask git the narrow question. Getting this wrong meant a single
// scratch file in an install directory stopped it updating permanently.
describe("dirty", () => {
  it("asks git to exclude untracked files", async () => {
    const { runner, calls } = fakeGit(CLEAN);
    await updateStatus(runner);
    expect(calls).toContainEqual(["git", "status", "--porcelain", "--untracked-files=no"]);
  });

  it("still refuses when a tracked file is modified", async () => {
    const { runner } = fakeGit({ ...CLEAN, "status --porcelain": " M relay/cli.ts" });
    expect((await updateStatus(runner)).dirty).toBe(true);
    expect(await runUpdate(runner)).toMatchObject({ ok: false, needsRestart: false });
  });
});

describe("runUpdate", () => {
  // Nothing to pull is not the same as nothing to do: a machine that pulled
  // but never restarted is still running the old code, and with no separate
  // Restart button there would be nothing left to click.
  it("still asks for a restart when the pull already happened", async () => {
    const { runner, calls } = fakeGit({ ...CLEAN, "rev-list --count": "0" });
    _setRunningShaForTest("old0000");
    const r = await runUpdate(runner);
    expect(r).toMatchObject({ ok: true, needsRestart: true });
    expect(calls.some((c) => c[1] === "pull")).toBe(false);
  });

  it("is a no-op when the running code is already current", async () => {
    const { runner } = fakeGit({ ...CLEAN, "rev-list --count": "0" });
    _setRunningShaForTest("aaa1111");
    expect(await runUpdate(runner)).toMatchObject({ ok: true, needsRestart: false });
  });

  it("runs pull, install and build in order, then asks for a restart", async () => {
    const { runner, calls } = fakeGit(CLEAN);
    const r = await runUpdate(runner);
    expect(r.ok).toBe(true);
    expect(r.needsRestart).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(["pull", "dependencies", "build"]);
    const order = calls.filter((c) => c[1] === "pull" || c[1] === "install" || c[1] === "run");
    expect(order.map((c) => c[1])).toEqual(["pull", "install", "run"]);
  });

  // Discarding a user's edits to get an update through trades a small
  // inconvenience for silent data loss.
  it("refuses to touch a dirty checkout", async () => {
    const { runner, calls } = fakeGit({ ...CLEAN, "status --porcelain": " M file.ts" });
    const r = await runUpdate(runner);
    expect(r.ok).toBe(false);
    expect(r.steps[0]!.detail).toMatch(/uncommitted/i);
    expect(calls.some((c) => c[1] === "pull")).toBe(false);
  });

  it("does nothing when already current", async () => {
    const { runner, calls } = fakeGit({ ...CLEAN, "rev-list --count": "0" });
    const r = await runUpdate(runner);
    expect(r.ok).toBe(true);
    expect(r.needsRestart).toBe(false);
    expect(calls.some((c) => c[1] === "pull")).toBe(false);
  });

  // Restarting onto a half-applied update is how a working install breaks.
  it("stops at the first failing step and does not ask for a restart", async () => {
    const { runner, calls } = fakeGit(CLEAN, "npm install");
    const r = await runUpdate(runner);
    expect(r.ok).toBe(false);
    expect(r.needsRestart).toBe(false);
    expect(r.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(calls.some((c) => c[2] === "cockpit:build")).toBe(false);
    // A failing npm prints hundreds of lines; only the head reaches the UI.
    expect(r.steps[1]!.detail).toMatch(/exploded/);
    expect(r.steps[1]!.detail).not.toMatch(/TAIL_NOISE/);
  });
});

describe("restartServices", () => {
  it("kickstarts both agents", () => {
    const calls: string[][] = [];
    restartServices((f, a) => calls.push([f, ...a]));
    expect(calls).toHaveLength(AGENT_LABELS.length);
    for (const c of calls) {
      expect(c[0]).toBe("launchctl");
      expect(c.slice(1, 3)).toEqual(["kickstart", "-k"]);
    }
  });
});

describe("remote check is cached", () => {
  const fetches = (calls: string[][]) => calls.filter((c) => c[1] === "fetch").length;

  // Fetching on every page load left the tab blank for seconds.
  it("does not fetch again within the TTL", async () => {
    const { runner, calls } = fakeGit(CLEAN);
    await updateStatus(runner, { now: () => 1000 });
    await updateStatus(runner, { now: () => 2000 });
    expect(fetches(calls)).toBe(1);
  });

  // "Check again" must actually check.
  it("fetches when forced", async () => {
    const { runner, calls } = fakeGit(CLEAN);
    await updateStatus(runner, { now: () => 1000 });
    await updateStatus(runner, { now: () => 1500, force: true });
    expect(fetches(calls)).toBe(2);
  });

  // Past the TTL the answer still comes from cache; the fetch happens behind it.
  it("answers immediately from cache once stale, refreshing in the background", async () => {
    const { runner, calls } = fakeGit(CLEAN);
    await updateStatus(runner, { now: () => 0 });
    const s = await updateStatus(runner, { now: () => 10 * 60 * 1000 });
    expect(s.latest).toBe("bbb2222"); // served from cache, not blank
    await new Promise((r) => setTimeout(r, 0));
    expect(fetches(calls)).toBe(2);
  });
});


describe("running vs checked-out commit", () => {
  // The restart poll hung forever: it watched HEAD, which moves at PULL time,
  // so "did the process restart" could never be answered by it.
  it("reports the commit the process loaded, not the checkout", async () => {
    const { runner } = fakeGit(CLEAN);
    _setRunningShaForTest("old1111");
    const s = await updateStatus(runner);
    expect(s.running).toBe("old1111");
    expect(s.current).toBe("aaa1111");
  });

  it("falls back to HEAD before the boot sha is captured", async () => {
    const { runner } = fakeGit(CLEAN);
    _setRunningShaForTest("");
    expect((await updateStatus(runner)).running).toBe("aaa1111");
  });
});
