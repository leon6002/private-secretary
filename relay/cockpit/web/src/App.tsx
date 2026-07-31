// App shell: 56px nav rail on the left, routed screen on the right.
//
// HashRouter, deliberately: the cockpit server only serves index.html at "/"
// (relay/cockpit/server.ts has no SPA-fallback route), so a BrowserRouter deep
// link like /people would 404 on reload. Hash URLs (#/people) keep routing
// entirely client-side with zero server changes.
import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { Calendar, CircleCheck, Users, Network, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "./lib/cn";
import QueueScreen from "./screens/QueueScreen";
import ProjectsScreen from "./screens/ProjectsScreen";
import PeopleScreen from "./screens/PeopleScreen";
import ConnectionsScreen from "./screens/ConnectionsScreen";
import SettingsScreen from "./screens/SettingsScreen";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Reserve the badge slot on Queue only — real count wiring lands with the
      Queue screen migration (S5). */
  badgeSlot?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Queue", icon: Calendar, badgeSlot: true },
  { to: "/projects", label: "Projects", icon: CircleCheck },
  { to: "/people", label: "People", icon: Users },
  // lucide has no "hub" glyph; Network is the closest match to the legacy
  // Material Symbols "hub" icon.
  { to: "/connections", label: "Connections", icon: Network },
  { to: "/settings", label: "Settings", icon: Settings },
];

function RailButton({ item }: { item: NavItem }) {
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
      {item.badgeSlot && (
        <span
          data-testid="pending-badge"
          hidden
          className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-primary text-white text-[10px] font-semibold leading-4 text-center"
        />
      )}
    </NavLink>
  );
}

export default function App() {
  return (
    <HashRouter>
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
              <RailButton key={item.to} item={item} />
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
            <Route path="/settings" element={<SettingsScreen />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
