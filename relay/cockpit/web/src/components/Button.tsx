// Minimal Button base component (shadcn/ui-style: variants via cn(), no Radix).
// Deliberately tiny in S1 — variants grow only when a migrated screen needs
// them; the placeholder screens don't use it yet.
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // type defaults to "button": inside future forms a bare <button> must
      // never implicitly submit.
      type={type ?? "button"}
      className={cn(
        "inline-flex items-center justify-center rounded px-3 py-1.5 text-body-medium transition-colors",
        "disabled:opacity-50 disabled:pointer-events-none",
        variant === "primary" && "bg-primary text-white hover:opacity-90",
        variant === "ghost" &&
          "border border-outline text-on-surface hover:bg-surface-variant",
        className,
      )}
      {...props}
    />
  );
});

export default Button;
