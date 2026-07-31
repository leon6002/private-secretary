// Shared placeholder for screens not yet migrated off the vanilla SPA.
// Every screen keeps the real 60px header bar (hairline bottom border, display
// title) so the shell navigation already feels final; only the body is a stub
// until the per-screen migration stages (S2–S5) replace it.
export default function ScreenPlaceholder({ title, stage }: { title: string; stage: string }) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-[60px] flex items-center px-6 border-b border-outline bg-surface flex-shrink-0">
        <h1 className="text-display">{title}</h1>
      </header>
      <div className="flex-1 flex items-center justify-center">
        <p className="text-body-base text-on-surface-variant">
          This screen is migrating to React — lands in {stage}.
        </p>
      </div>
    </div>
  );
}
