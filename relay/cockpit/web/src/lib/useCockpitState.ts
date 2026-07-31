// useCockpitState — the shared /api/state feed every cockpit screen reads.
//
// Contract:
// - Fetches immediately on mount, then re-polls every 15s (the legacy SPA's
//   cadence) until the component unmounts; the interval is cleared and late
//   responses are dropped on unmount, so nothing setStates a dead component.
// - Returns { state, error }: `state` is the LAST SUCCESSFUL payload (null
//   until the first success), `error` the Error from the most recent poll
//   attempt (null whenever the last poll succeeded). A failed poll never
//   wipes good data — screens keep rendering the stale snapshot while
//   `error` says the feed is sick; the next success clears it.
//
// Deliberate simplification vs legacy: public/js/main.js computed a
// stateSig() over the payload to skip re-rendering when nothing visible
// changed. React re-renders are cheap and this payload is small, so every
// successful poll simply sets state — no signature diffing.
import { useEffect, useState } from "react";
import { apiGet } from "./api";

export interface SourceError {
  message: string;
  at: string; // ISO timestamp
}

// Only the fields migrated screens actually read are typed here; the payload
// carries more (clusters, counts, gate, …) — add fields as S3–S5 need them
// rather than mirroring the whole server-side CockpitState up front.
export interface CockpitStateData {
  sourceErrors?: Record<string, SourceError>;
}

const POLL_MS = 15_000;

export function useCockpitState(): { state: CockpitStateData | null; error: Error | null } {
  const [state, setState] = useState<CockpitStateData | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const data = await apiGet<CockpitStateData>("/api/state");
        if (cancelled) return;
        setState(data);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Keep `state` untouched: one failed tick must not blank the screen.
        setError(e instanceof Error ? e : new Error(String(e)));
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { state, error };
}
