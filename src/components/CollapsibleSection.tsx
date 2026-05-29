import { type ReactNode } from "react";
import { IconChevronDown } from "./Icons";

type Props = {
  id: string;
  label: string;
  meta?: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
};

export function CollapsibleSection({ label, meta, summary, open, onToggle, children }: Props) {
  return (
    <div className={"cp-section collapsible" + (open ? "" : " collapsed")}>
      <div className="cp-section-head" onClick={onToggle}>
        <IconChevronDown size={11} className="chev" />
        <span className="label">{label}</span>
        <span className="meta">{open ? meta : (summary ?? meta)}</span>
      </div>
      <div className="cp-section-body">{children}</div>
    </div>
  );
}
