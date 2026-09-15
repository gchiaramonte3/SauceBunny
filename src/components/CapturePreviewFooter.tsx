import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep dialog actions outside its scrolling fields. Standalone/catalog
 * pickers retain the same inline actions when no footer slot is supplied. */
export function CapturePreviewFooter({ target, children }: { target?: HTMLElement | null; children: ReactNode }) {
  const content = <div className="cp-capture-preview-foot">{children}</div>;
  return target ? createPortal(content, target) : content;
}
