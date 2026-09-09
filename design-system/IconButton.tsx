import { forwardRef } from "react";
import { Button, type ButtonProps } from "./Button";

export type IconButtonProps = Omit<ButtonProps, "aria-label"> & { label: string };

/** Label is mandatory; the glyph remains decorative. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, title = label, className = "", children, ...props }, ref,
) {
  return <Button {...props} ref={ref} title={title} aria-label={label}
    className={`cp-ds-icon-button ${className}`.trim()}>
    <span className="cp-ds-icon-glyph" aria-hidden="true">{children}</span>
  </Button>;
});
