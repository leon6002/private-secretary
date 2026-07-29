// macOS local notification helper. osascript wrapper — the secretary
// daemon's only user-visible artifact when it's healthy is the cockpit
// queue; failures need to surface SOMEHOW or the user has to open Logs
// to know the LaunchAgent died. A native banner is the lowest-friction
// signal.
//
// No npm dependency — shells out to /usr/bin/osascript with
// `display notification` AppleScript. Failures here are non-fatal:
// if osascript is missing or the user is in a context where notify
// won't work, we just log and move on rather than crash the daemon.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface NotifyOptions {
  title: string;
  body: string;
  // Default "Taiv Secretary". Visible in Notification Center.
  subtitle?: string;
  // Default "default" (system sound). Pass null for silent.
  sound?: string | null;
}

// Escape user-provided strings to keep them inside AppleScript string
// literals. AppleScript escapes are " \\ \r \n; we go conservative.
function escapeApplescript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function notify(opts: NotifyOptions): Promise<{ ok: boolean; error?: string }> {
  const title = escapeApplescript(opts.title);
  const body = escapeApplescript(opts.body);
  const subtitle = escapeApplescript(opts.subtitle ?? "Taiv Secretary");
  const sound = opts.sound === null ? "" : ` sound name "${escapeApplescript(opts.sound ?? "default")}"`;
  const script = `display notification "${body}" with title "${title}" subtitle "${subtitle}"${sound}`;
  try {
    await execFileP("osascript", ["-e", script]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
