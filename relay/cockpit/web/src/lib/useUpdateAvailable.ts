// Whether a newer version is waiting, shared by the nav rail and the Update
// tab so they cannot disagree.
//
// Polls rarely on purpose. The server caches the remote check for five
// minutes and refreshes it behind the response, so asking more often would
// only re-read the same cached answer; every fifteen minutes is enough to
// notice a release without adding noise.
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "./api";

const POLL_MS = 15 * 60 * 1000;

export interface UpdateInfo {
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

  const refresh = useCallback((force = false) => {
    apiGet<UpdateInfo>(`/api/update${force ? "?force=1" : ""}`)
      .then(setInfo)
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
