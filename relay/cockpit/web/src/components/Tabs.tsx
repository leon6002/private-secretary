// Generic tab bar (S3, Settings). DESIGN.md styling: a hairline bottom border
// across the row; the active tab gets the primary-blue underline + text, the
// rest are muted until hovered. Controlled — the parent owns the active id.
import { cn } from "../lib/cn";

export interface TabItem {
  id: string;
  label: string;
}

export default function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-5 border-b border-outline" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            // -mb-px lets the 2px active underline sit ON the row's hairline
            // instead of doubling it.
            "pb-2 -mb-px text-body-medium border-b-2 transition-colors",
            active === t.id
              ? "border-primary text-primary"
              : "border-transparent text-on-surface-variant hover:text-on-surface",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
