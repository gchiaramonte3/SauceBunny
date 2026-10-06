import { useId, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { MultitrackExportFormat } from "../hooks/use-multitrack-export";
import { AnchoredPopover } from "./AnchoredPopover";
import { IconChevronDown } from "./Icons";
import { MultitrackShootDate } from "./MultitrackShootDate";

/**
 * Everything the export footer offers beyond exporting the person on screen:
 * the checked tracks, the whole transcript, Avid markers by mic or person, and
 * the shoot date the text and PDF carry. They were three buttons, a disclosure
 * and a caption note under the format and Export, which is most of what made
 * the panel's foot "just too much".
 */
export function MultitrackExportMore({ document, format, busy, grouped, selected, entire, byPerson, onSelected, onEntire, onByPerson }: {
  document: AafDocument; format: MultitrackExportFormat; busy: boolean; grouped: boolean;
  /** The checked timeline tracks, when the page has checkboxes. */
  selected: { count: number; ready: boolean } | null;
  entire: boolean; byPerson: boolean; onSelected: () => void; onEntire: () => void; onByPerson: () => void;
}) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null), id = useId();
  const run = (action: () => void) => () => { setOpen(false); action(); };
  return <>
    <button ref={trigger} type="button" className="btn btn-ghost cp-multitrack-export-more" aria-label="More ways to export" title="More ways to export"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseDown={(event) => event.stopPropagation()} onClick={() => setOpen((value) => !value)}><IconChevronDown size={14} /></button>
    {open && <AnchoredPopover anchor={trigger} id={id} label="More ways to export" className="cp-multitrack-export-popover" above alignEnd onClose={() => setOpen(false)}>
      {selected && <button type="button" className="cp-popover-item" title="Export saved transcripts from the checked timeline tracks" disabled={busy || !selected.ready}
        onClick={run(onSelected)}><span className="lbl">Export selected ({selected.count})</span></button>}
      <button type="button" className="cp-popover-item" disabled={busy || !entire} onClick={run(onEntire)}><span className="lbl">Entire transcript</span></button>
      <button type="button" className="cp-popover-item" disabled={busy || !byPerson} onClick={run(onByPerson)}
        title={grouped ? "Save one file per microphone, targeting its parent sequence track" : "Save a separate Avid marker file for each person"}>
        <span className="lbl">{grouped ? "Avid files by microphone" : "Avid files by person"}</span></button>
      {format === "srt" && <p className="cp-multitrack-note">Sequence-relative captions, with mic-owner labels. Untimed text stays in text, CSV and PDF.</p>}
      {(format === "txt" || format === "pdf") && <MultitrackShootDate document={document} />}
    </AnchoredPopover>}
  </>;
}
