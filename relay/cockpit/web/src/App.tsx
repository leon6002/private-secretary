// App shell: 56px nav rail on the left, routed screen on the right.
//
// HashRouter, deliberately: the cockpit server only serves index.html at "/"
// (relay/cockpit/server.ts has no SPA-fallback route), so a BrowserRouter deep
// link like /people would 404 on reload. Hash URLs (#/people) keep routing
// entirely client-side with zero server changes.
//
// The shell owns the cross-screen machinery that legacy public/js/main.js
// owned: the boot sequence (flush-auto BEFORE the first state fetch, so the
// queue is human-only from the first paint), the single /api/state feed
// (handed to screens via CockpitFeedContext), the Queue pending badge, the
// global keydown listener (g-prefix navigation, "?" help sheet, Escape), and
// the help sheet itself. Screen-local keys (j/k/a/e/s on the Queue) live in
// the Queue screen — legacy gated them on App.screen, and an unmounted screen
// registering no listener is the React equivalent.
import { useEffect, useRef, useState } from "react";
import { HashRouter, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { Calendar, CalendarDays, CircleCheck, Users, Network, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiPost } from "./lib/api";
import { cn } from "./lib/cn";
import { isUpdateAvailable, useUpdateAvailable } from "./lib/useUpdateAvailable";
import { Toaster } from "./lib/toast";
import { CockpitFeedContext, useCockpitState } from "./lib/useCockpitState";
import QueueScreen from "./screens/QueueScreen";
import ProjectsScreen from "./screens/ProjectsScreen";
import PeopleScreen from "./screens/PeopleScreen";
import ConnectionsScreen from "./screens/ConnectionsScreen";
import CalendarScreen from "./screens/CalendarScreen";
import SettingsScreen from "./screens/SettingsScreen";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: "/", label: "Queue", icon: Calendar },
  { to: "/projects", label: "Projects", icon: CircleCheck },
  { to: "/people", label: "People", icon: Users },
  // lucide has no "hub" glyph; Network is the closest match to the legacy
  // Material Symbols "hub" icon.
  { to: "/connections", label: "Connections", icon: Network },
  // Queue took the plain Calendar glyph first; CalendarDays distinguishes
  // the week view at a glance.
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/settings", label: "Settings", icon: Settings },
];

function RailButton({
  item,
  badge,
  dot,
}: {
  item: NavItem;
  badge?: number;
  /** A quiet "something is waiting here" mark — used for an available update. */
  dot?: boolean;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      aria-label={item.label}
      title={item.label}
      className={({ isActive }) =>
        cn(
          "relative w-10 h-10 flex items-center justify-center",
          "text-on-surface-variant hover:text-on-surface border-l-2 border-transparent transition-colors",
          isActive && "text-primary bg-primary/10 border-l-primary",
        )
      }
    >
      <Icon size={20} strokeWidth={1.75} />
      {dot && (
        <span
          data-testid="update-dot"
          aria-label="Update available"
          className="absolute top-1 right-1 w-2 h-2 rounded-full bg-primary"
        />
      )}
      {item.to === "/" && (
        <span
          data-testid="pending-badge"
          hidden={!badge}
          className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[10px] font-semibold leading-4 text-center"
        >
          {badge || null}
        </span>
      )}
    </NavLink>
  );
}

// The keyboard help sheet ("?" opens, Escape / close button / backdrop click
// closes) — legacy index.html's #help-sheet, with the shortcut list updated
// to the new mapping (g→s is Settings; the legacy Activity screen is gone).
function HelpSheet({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["j / k", "next / previous task"],
    ["a", "approve & send"],
    ["e", "edit draft"],
    ["s", "skip"],
    ["g then q / t / p / c / a / s", "Queue / Projects / People / Connections / Calendar / Settings"],
    ["?", "this sheet"],
  ];
  return (
    <div
      className="fixed inset-0 bg-black/35 flex items-center justify-center z-[200]"
      onClick={(e) => {
        // Click anywhere on the backdrop (outside the card) closes the sheet.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface border border-outline rounded-lg p-6 min-w-[320px]">
        <h2 className="text-headline mb-3.5">Keyboard</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 mb-4">
          {rows.map(([dt, dd]) => (
            <div key={dt} className="contents">
              <dt className="font-semibold text-on-surface text-body-base">{dt}</dt>
              <dd className="text-on-surface-variant text-body-base m-0">{dd}</dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          onClick={onClose}
          className="border border-outline rounded px-3 py-1.5 text-body-base hover:bg-surface-variant"
        >
          close
        </button>
      </div>
    </div>
  );
}

// Everything inside the Router: navigation, the state feed, global keys.
function Shell() {
  const navigate = useNavigate();
  // Boot order is legacy main.js's: flush high-confidence auto-handled items
  // FIRST, then start fetching state — so the first paint is already
  // human-only. A failed flush is ignored (legacy .catch(() => {})).
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    apiPost("/api/flush-auto", {})
      .catch(() => {})
      .finally(() => setBooted(true));
  }, []);
  const feed = useCockpitState({ enabled: booted });
  const { info: updateInfo } = useUpdateAvailable();
  const updateWaiting = isUpdateAvailable(updateInfo);
  const pending = feed.state?.counts?.pending ?? 0;

  const [helpOpen, setHelpOpen] = useState(false);
  const gPrefix = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // No shortcuts while typing — legacy checked e.target the same way.
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
      const k = e.key;
      if (gPrefix.current) {
        gPrefix.current = false;
        if (k === "q") navigate("/");
        else if (k === "t") navigate("/projects");
        else if (k === "p") navigate("/people");
        else if (k === "c") navigate("/connections");
        // "a" = cAlendar — "c" was already Connections.
        else if (k === "a") navigate("/calendar");
        else if (k === "s") navigate("/settings");
        return;
      }
      if (k === "g") {
        gPrefix.current = true;
        return;
      }
      if (k === "?") {
        setHelpOpen(true);
        return;
      }
      if (k === "Escape") setHelpOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <CockpitFeedContext.Provider value={feed}>
      <div className="h-screen flex overflow-hidden bg-background text-on-surface font-sans">
        {/* 56px global nav rail — same silhouette as the legacy SPA. */}
        <nav
          className="w-[56px] h-full bg-surface border-r border-outline flex flex-col items-center py-4 flex-shrink-0 z-10"
          aria-label="Primary"
        >
          <div className="w-10 h-10 bg-surface-variant rounded flex items-center justify-center mb-8">
            <span className="font-bold text-[20px]">s.</span>
          </div>
          <div className="flex flex-col gap-6 flex-1 w-full items-center">
            {NAV.map((item) => (
              <RailButton
                key={item.to}
                item={item}
                badge={item.to === "/" ? pending : undefined}
                // Settings holds the Update tab, so that is where the mark belongs.
                dot={item.to === "/settings" && updateWaiting}
              />
            ))}
          </div>
          <div className="mt-auto w-8 h-8 rounded-full bg-surface-variant" />
        </nav>

        <main className="flex-1 flex flex-col min-w-0" aria-live="polite">
          <Routes>
            <Route path="/" element={<QueueScreen />} />
            <Route path="/projects" element={<ProjectsScreen />} />
            <Route path="/people" element={<PeopleScreen />} />
            <Route path="/connections" element={<ConnectionsScreen />} />
            <Route path="/calendar" element={<CalendarScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
          </Routes>
        </main>
        {helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} />}
        {/* Single toast outlet for the whole app — see src/lib/toast.tsx. */}
        <Toaster />
      </div>
    </CockpitFeedContext.Provider>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
