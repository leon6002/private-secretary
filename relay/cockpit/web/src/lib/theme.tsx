// Theme: light / dark / system three-state for the whole app.
//
// The palette itself lives in src/index.css as CSS variables (:root vs .dark);
// this module only decides WHICH set is active by toggling the .dark class on
// <html>. "system" (the default) follows prefers-color-scheme and tracks live
// OS changes; an explicit light/dark choice is a user override persisted to
// localStorage["secretary-theme"] and wins over the OS. The Settings screen
// (S3) is the UI for setPreference.
//
// matchMedia is feature-guarded (?.): jsdom doesn't implement it, and the
// guards keep both tests and any non-browser render from crashing — the
// fallback is light.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "secretary-theme";

function readStoredPreference(): ThemePreference {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

interface ThemeValue {
  /** What the user picked (or the default "system"). */
  preference: ThemePreference;
  /** The theme actually applied right now. */
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeValue>({
  preference: "system",
  resolved: "light",
  setPreference: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Track the OS theme while we care about it. Subscribing is cheap and the
  // listener is inert when preference !== "system" (systemDark just goes
  // unread), so there is no conditional-subscribe dance.
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, p);
    setPreferenceState(p);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
