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

export function CollapsibleSection({ id, label, meta, summary, open, onToggle, children }: Props) {
  // The header is a real <button> (it used to be a clickable <div> that also
  // ignored its id prop): keyboard-focusable, announces as collapsed/expanded,
  // and aria-controls ties it to the body it discloses. The CSS resets the
  // button chrome so the visual is unchanged.
  const bodyId = `${id}-body`;
  return (
    <div className={"cp-section collapsible" + (open ? "" : " collapsed")}>
      <button
        type="button"
        id={id}
        className="cp-section-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <IconChevronDown size={11} className="chev" />
        <span className="label">{label}</span>
        <span className="meta">{open ? meta : (summary ?? meta)}</span>
      </button>
      <div className="cp-section-body" id={bodyId}>{children}</div>
    </div>
  );
}
