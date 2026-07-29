import { describe, it, expect } from "vitest";
import {
  readHeartbeat,
  Scheduler,
  type Clock,
} from "./scheduler.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Manual time-control clock. Tests step time forward explicitly via
// tickTime(); pending callbacks fire in order when their deadline is
// reached.
interface PendingTimer {
  deadlineMs: number;
  cb: () => void;
  cancelled: boolean;
}

function testClock(initial: number = 1_000_000): {
  clock: Clock;
  advance: (ms: number) => Promise<void>;
  now: () => number;
} {
  let nowMs = initial;
  const timers: PendingTimer[] = [];
  const clock: Clock = {
    nowMs: () => nowMs,
    setTimeout: (cb, ms) => {
      const t: PendingTimer = { deadlineMs: nowMs + ms, cb, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  async function advance(ms: number): Promise<void> {
    // Advance the wall clock first, then fire all due timers. This
    // matches how real setTimeout behaves after a Mac sleeps past a
    // deadline: when the kernel wakes the process, Date.now() has
    // already jumped — the callback sees the post-sleep time, not
    // the original deadline.
    nowMs += ms;
    while (true) {
      const due = timers
        .filter((t) => !t.cancelled && t.deadlineMs <= nowMs)
        .sort((a, b) => a.deadlineMs - b.deadlineMs);
      const first = due[0];
      if (!first) break;
      const idx = timers.indexOf(first);
      if (idx >= 0) timers.splice(idx, 1);
      first.cb();
      // yield to microtasks (the cb may await; let the promise chain run)
      await new Promise((r) => setImmediate(r));
    }
  }
  return { clock, advance, now: () => nowMs };
}

describe("Scheduler", () => {
  it("fires first tick immediately, then every interval", async () => {
    const { clock, advance } = testClock();
    const ticks: number[] = [];
    const s = new Scheduler({
      intervalMs: 100,
      clock,
      onTick: async (info) => {
        ticks.push(info.ordinal);
      },
    });
    s.start();
    await advance(0); // first tick (scheduled at +0)
    expect(ticks).toEqual([1]);
    await advance(100);
    expect(ticks).toEqual([1, 2]);
    await advance(100);
    expect(ticks).toEqual([1, 2, 3]);
    s.stop();
  });

  it("first-ever tick has sinceLastMs=Infinity, onWake=false", async () => {
    const { clock, advance } = testClock();
    let seen: { sinceLastMs: number; onWake: boolean } | null = null;
    const s = new Scheduler({
      intervalMs: 100,
      clock,
      onTick: async (info) => {
        seen = { sinceLastMs: info.sinceLastMs, onWake: info.onWake };
      },
    });
    s.start();
    await advance(0);
    expect(seen).toEqual({ sinceLastMs: Infinity, onWake: false });
    s.stop();
  });

  it("detects wake when sinceLastMs > interval * 1.5", async () => {
    const { clock, advance } = testClock();
    const wakes: boolean[] = [];
    const s = new Scheduler({
      intervalMs: 100,
      clock,
      onTick: async (info) => {
        wakes.push(info.onWake);
      },
    });
    s.start();
    await advance(0); // tick 1 (no wake — first)
    // Simulate 5x the interval passing (Mac slept). Because the
    // scheduler scheduled the next tick at +100, we just advance 500ms;
    // the timer fires immediately when crossed.
    await advance(500);
    s.stop();
    // tick 1: onWake=false. tick 2: 500ms later (>= 1.5*100) → onWake=true
    expect(wakes[0]).toBe(false);
    expect(wakes[1]).toBe(true);
  });

  it("writes heartbeat each tick when heartbeatPath provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    try {
      const { clock, advance } = testClock();
      const s = new Scheduler({
        intervalMs: 100,
        clock,
        heartbeatPath: join(dir, "heartbeat.json"),
        onTick: async () => {},
      });
      s.start();
      await advance(0);
      const hb1 = readHeartbeat(join(dir, "heartbeat.json"));
      expect(hb1?.lastTickOrdinal).toBe(1);
      await advance(100);
      const hb2 = readHeartbeat(join(dir, "heartbeat.json"));
      expect(hb2?.lastTickOrdinal).toBe(2);
      s.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invokes onError when a tick throws, keeps running", async () => {
    const { clock, advance } = testClock();
    const errors: string[] = [];
    let n = 0;
    const s = new Scheduler({
      intervalMs: 100,
      clock,
      onTick: async () => {
        n++;
        if (n === 1) throw new Error("boom");
      },
      onError: (e) => errors.push(e.message),
    });
    s.start();
    await advance(0);
    await advance(100);
    s.stop();
    expect(errors).toEqual(["boom"]);
    expect(n).toBe(2); // tick 2 fired despite tick 1's error
  });

  it("stop() cancels pending timer; no further ticks", async () => {
    const { clock, advance } = testClock();
    let n = 0;
    const s = new Scheduler({
      intervalMs: 100,
      clock,
      onTick: async () => {
        n++;
      },
    });
    s.start();
    await advance(0);
    s.stop();
    await advance(1000);
    expect(n).toBe(1);
  });
});
