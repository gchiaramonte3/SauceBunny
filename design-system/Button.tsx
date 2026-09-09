import { forwardRef, type ButtonHTMLAttributes } from "react";
import "./controls.css";

export type ButtonVariant = "normal" | "primary" | "quiet";
export type ButtonSize = "standard" | "compact";
export type ButtonTone = "normal" | "danger";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
};

/** Catalog-only extraction of the existing neutral, beveled button family. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "normal", size = "standard", tone = "normal", className = "", type = "button", ...props }, ref,
) {
  return <button {...props} ref={ref} type={type}
    className={`cp-ds-button ${className}`.trim()}
    data-variant={variant} data-size={size} data-tone={tone} />;
});
