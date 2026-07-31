// cn() — the shadcn/ui convention for composing conditional Tailwind classes:
// clsx handles the conditional logic, tailwind-merge resolves conflicts
// (later class wins, e.g. cn("p-2", "p-4") → "p-4") so callers can override
// a component's defaults without fighting specificity.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
