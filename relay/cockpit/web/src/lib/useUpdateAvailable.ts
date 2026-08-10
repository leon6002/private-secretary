// Whether a newer version is waiting, shared by the nav rail and the Update
// tab so they cannot disagree.
//
// It also watches for the restart. An update — clicked or unattended — swaps
// the code under an open tab, and a page left on the old bundle shows stale
// markup against a new API. Nothing else can notice: the cockpit is one of the
// processes being restarted, so it cannot report its own restart. The only
// honest signal is the commit it reports AFTER coming back, which is why this
// polls on a cadence a person would accept waiting through rather than the
// fifteen minutes the version check alone would need. The remote fetch is
// cached server-side for five minutes, so the extra polls cost two local git
// reads and no network.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "./api";

const POLL_MS = 30_000;

export interface UpdateInfo {
  /** Commit the answering process was launched from — changes only on restart. */
  running: string;
  current: string;
  currentSubject: string;
  latest: string;
  behind: number;
  dirty: boolean;
  branch: string;
  error?: string;
}

export function useUpdateAvailable(): { info: UpdateInfo | null; refresh: (force?: boolean) => void } {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const firstRunning = useRef<string | null>(null);

  const refresh = useCallback((force = false) => {
    apiGet<UpdateInfo>(`/api/update${force ? "?force=1" : ""}`)
      .then((next) => {
        setInfo(next);
        if (!next.running) return;
        if (firstRunning.current === null) firstRunning.current = next.running;
        // Back on a different commit than the one this page was served by.
        else if (next.running !== firstRunning.current) window.location.reload();
      })
      // A machine with no git still has a working cockpit; a failed check
      // must never surface as "update available".
      .catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return { info, refresh };
}

export function isUpdateAvailable(info: UpdateInfo | null): boolean {
  return !!info && !info.error && info.behind > 0;
}
