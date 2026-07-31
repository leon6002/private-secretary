// toast(msg, isErr?) + <Toaster /> — the React port of legacy state.js's
// toast (a fixed bottom-center chip that removes itself after 2.6s).
//
// Module-level fan-out instead of a context provider: any event handler in
// the app can call toast() without prop drilling, and the single <Toaster />
// mounted in App.tsx is the only subscriber. Calling toast() with no Toaster
// mounted is a no-op (tests exercise screens without the shell).
//
// Styling follows DESIGN.md (no shadows, hairline-free solid chips): a normal
// toast is an inverted chip (bg-on-surface / text-surface — dark chip in
// light mode, light chip in dark mode, both via semantic tokens), an error
// toast is bg-error. Legacy used a hard-coded dark background + shadow; the
// token version reads the same in both themes.
import { useEffect, useState } from "react";
import { cn } from "./cn";

interface ToastItem {
  id: number;
  msg: string;
  isErr: boolean;
}

let nextId = 0;
const listeners = new Set<(t: ToastItem) => void>();

export function toast(msg: string, isErr = false): void {
  const item: ToastItem = { id: ++nextId, msg, isErr };
  for (const l of listeners) l(item);
}

const TOAST_MS = 2600;

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const add = (t: ToastItem) => {
      setItems((prev) => [...prev, t]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), TOAST_MS);
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
    };
  }, []);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            "px-4 py-2.5 rounded text-body-base",
            t.isErr ? "bg-error text-white" : "bg-on-surface text-surface",
          )}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
