// Button — shadcn/ui's button, adapted to the cockpit's legacy variant names
// (primary / ghost) so existing callers keep working unchanged. All the craft
// (focus ring, hover darken, press feedback, size presets) comes from shadcn.
import { forwardRef } from "react";
import { Button as ShadcnButton, type ButtonProps as ShadcnButtonProps } from "./ui/button";
import { cn } from "../lib/cn";

export interface ButtonProps extends Omit<ShadcnButtonProps, "variant"> {
  variant?: "primary" | "ghost";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", className, ...props },
  ref,
) {
  return (
    <ShadcnButton ref={ref} variant={variant === "primary" ? "default" : "outline"} className={cn(className)} {...props} />
  );
});

export default Button;
