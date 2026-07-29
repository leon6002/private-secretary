// In-process scan scheduler. The Phase-3 design point (per
// specs/phase3-local-mac.md §1) is ONE LaunchAgent process that owns
// scheduling — no launchd timer, no separate watchdog. This is the
// piece that decides "is it time to scan again?".
//
// Key behaviours:
//   - Interval-driven tick (default 30 min, env-overridable). Fires
//     immediately on start (catch-up after restart), then on the
//     interval.
//   - Wall-clock-gap detection: between two ticks we record the
//     wall-clock time, and on the next fire we check if the elapsed
//     time is much larger than the interval (the MacBook Air slept).
//     If so the tick is flagged onWake=true so the scan-loop can choose
//     to widen its bootstrap window or skip a step that just happened.
//   - Heartbeat write: every successful tick stamps a heartbeat file
//     so a separate liveness probe (launchd KeepAlive, or a future
//     watchdog) can see "the loop is alive".
//   - Injectable clock + setTimeout for tests — no real wallclock or
//     setTimeout calls reach the implementation when a TestClock is
//     plugged in.
//
// The actual SCAN happens in relay/proc/scan-loop.ts; this module is
// just the trigger.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_SCAN_INTERVAL_MS = 30 * 60_000;

// If the gap between two ticks is more than this multiple of the
// interval, treat it as a wake-from-sleep tick.
export const WAKE_GAP_FACTOR = 1.5;

export interface TickInfo {
  // Wall-clock ms epoch the tick fired at.
  atMs: number;
  // ms since the previous tick (Infinity on the first fire).
  sinceLastMs: number;
  // True if sinceLastMs > interval * WAKE_GAP_FACTOR — caller can choose
  // to widen the scan window or run a catch-up bootstrap.
  onWake: boolean;
  // Ordinal — useful for logs.
  ordinal: number;
}

export interface Clock {
  nowMs(): number;
  // Returns a handle that, when invoked, cancels the pending timeout.
  setTimeout(cb: () => void, ms: number): () => void;
}

export const realClock: Clock = {
  nowMs: () => Date.now(),
  setTimeout: (cb, ms) => {
    const id = setTimeout(cb, ms);
    return () => clearTimeout(id);
  },
};

export interface SchedulerOptions {
  // Path the scheduler writes heartbeat ticks to. Skipping this disables
  // heartbeat writes (tests).
  heartbeatPath?: string;
  // Interval between ticks. ms.
  intervalMs?: number;
  // Clock + timer injection for tests.
  clock?: Clock;
  // Fired on each tick. The scheduler does NOT await the callback's
  // return before scheduling the next tick — long scans must complete
  // before the next interval or the user-visible cadence drifts.
  // (Practical: a 5-min scan inside a 30-min interval still fires every
  // 30 min from the start of the previous scan.)
  onTick: (info: TickInfo) => Promise<void>;
  // Fired when a tick callback throws. The scheduler keeps running.
  onError?: (err: Error, info: TickInfo) => void;
}

export interface Heartbeat {
  pid: number;
  startedAtMs: number;
  lastTickAtMs: number;
  lastTickOrdinal: number;
  intervalMs: number;
}

export function readHeartbeat(path: string): Heartbeat | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

function writeHeartbeat(path: string, hb: Heartbeat): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(hb, null, 2), "utf8");
  renameSync(tmp, path);
}

export class Scheduler {
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly opts: SchedulerOptions;
  private running = false;
  private cancelTimer: (() => void) | null = null;
  private lastTickMs = -Infinity;
  private ordinal = 0;
  private readonly startedAtMs: number;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? realClock;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.startedAtMs = this.clock.nowMs();
  }

  // Start the loop. First tick fires synchronously-via-microtask so a
  // brand-new process catches up immediately rather than waiting an
  // interval to do its first scan.
  start(): void {
    if (this.running) return;
    this.running = true;
    // Schedule first tick on next tick of event loop.
    this.cancelTimer = this.clock.setTimeout(() => void this.fire(), 0);
  }

  // Stop the loop. Pending timer cancelled. A tick mid-flight is NOT
  // cancelled — it finishes naturally; no next tick is scheduled.
  stop(): void {
    this.running = false;
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  private async fire(): Promise<void> {
    if (!this.running) return;
    const now = this.clock.nowMs();
    const sinceLastMs = this.lastTickMs === -Infinity ? Infinity : now - this.lastTickMs;
    const onWake = Number.isFinite(sinceLastMs)
      ? sinceLastMs > this.intervalMs * WAKE_GAP_FACTOR
      : false;
    this.ordinal++;
    const info: TickInfo = {
      atMs: now,
      sinceLastMs,
      onWake,
      ordinal: this.ordinal,
    };
    try {
      await this.opts.onTick(info);
      if (this.opts.heartbeatPath) {
        writeHeartbeat(this.opts.heartbeatPath, {
          pid: process.pid,
          startedAtMs: this.startedAtMs,
          lastTickAtMs: now,
          lastTickOrdinal: this.ordinal,
          intervalMs: this.intervalMs,
        });
      }
    } catch (e) {
      this.opts.onError?.(e as Error, info);
    } finally {
      this.lastTickMs = now;
      if (this.running) {
        this.cancelTimer = this.clock.setTimeout(
          () => void this.fire(),
          this.intervalMs,
        );
      }
    }
  }
}
