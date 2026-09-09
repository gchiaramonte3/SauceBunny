import type { HTMLAttributes } from "react";
import "./controls.css";

export type StatusBadgeTone = "neutral" | "live" | "success" | "warning" | "danger";
export type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: StatusBadgeTone };

/** Passive status, never a button. Live and success share a color, not meaning. */
export function StatusBadge({ tone = "neutral", className = "", children, ...props }: StatusBadgeProps) {
  return <span {...props} className={`cp-ds-status-badge ${className}`.trim()} data-tone={tone}>
    {tone === "live" && <span className="cp-ds-status-dot" aria-hidden="true" />}{children}
  </span>;
}
