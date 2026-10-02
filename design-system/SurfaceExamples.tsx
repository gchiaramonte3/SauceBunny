import { useCallback, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconInfo, IconFolder, IconFilm, IconCircleX as IconX } from "../src/components/Icons";
import { CollapsibleSection } from "../src/components/CollapsibleSection";
import { ModelDownloadProgress } from "../src/components/ModelDownloadProgress";
import { Tooltip } from "../src/components/Tooltip";
import { useModalFocus } from "../src/hooks/use-modal-focus";
import { useDismiss } from "../src/hooks/use-dismiss";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { StatusBadge } from "./StatusBadge";
import { Comparison } from "./Comparison";
import type { ExampleProps } from "./example-types";
import "./table-fixture.css";
import { ClipTagExamples } from "./ClipTagExamples";

const currentRows = [
  { name: "Assembly_v03.mov", size: "428 MB", modified: "Sep 7, 2026" },
  { name: "Interview_with_a_very_long_descriptive_filename.mov", size: "2.4 GB", modified: "September 7, 2026 at 11:12 AM" },
  { name: "Séquence_finale_東京.mov", size: "216 MB", modified: "Sep 6, 2026" },
];

/**
 * Isolated markup excerpt, not LibraryBrowserPane (which owns real files).
 * Keep its load-bearing structure: header first, row buttons next, column
 * rules last. Production CSS owns the 27px rows, typography, selection,
 * per-cell clipping and ::after stripes. Only width and floor height belong
 * to the fixture. The example omits Kind, as the real column model permits.
 */
function CurrentTable({ narrow = false }: { narrow?: boolean }) {
  const [ascending, setAscending] = useState(true);
  const [selectedName, setSelectedName] = useState(currentRows[0].name);
  const rows = [...currentRows].sort((a, b) => a.name.localeCompare(b.name) * (ascending ? 1 : -1));
  const template = "34px minmax(0, 1fr) 64px 84px";
  const tableStyle = {
    "--lrow-cols": template,
    // Same parity rule as listFillPhase: three rows end striped, so the
    // empty floor begins plain. No import of the production library store.
    "--lrow-fill-phase": rows.length % 2 === 0 ? "1" : "0",
  } as CSSProperties;

  return <div
    className="cp-ds-current-grid"
    data-narrow={narrow}
    data-testid={narrow ? "table-current-narrow" : "table-current"}
  >
    <div className="cp-lib-list" style={tableStyle} role="group" aria-label={narrow ? "Narrow source-markup file table" : "Source-markup file table"}>
      <div className="cp-lib-list-head">
        <span className="cp-lib-lrow-art" aria-hidden />
        <button
          type="button"
          className="cp-lib-lrow-name cp-lib-sorthead active"
          aria-label={`Sort example files by name ${ascending ? "descending" : "ascending"}`}
          data-sort={ascending ? "ascending" : "descending"}
          onClick={() => setAscending(!ascending)}
        >
          Name <span className="cp-lib-sorthead-caret" aria-hidden>{ascending ? "▲" : "▼"}</span>
        </button>
        <span className="cp-lib-lrow-size">Size</span>
        <span className="cp-lib-lrow-date">Modified</span>
      </div>
      {rows.map((row) => <button
        key={row.name}
        type="button"
        className={`cp-lib-lrow${selectedName === row.name ? " selected" : ""}`}
        title={row.name}
        aria-label={`Select example file ${row.name}`}
        aria-pressed={selectedName === row.name}
        onClick={() => setSelectedName(row.name)}
      >
        <span className="cp-lib-lrow-art" aria-hidden><IconFilm size={13} /></span>
        <span className="cp-lib-lrow-name">{row.name}</span>
        <span className="cp-lib-lrow-size">{row.size}</span>
        <span className="cp-lib-lrow-date">{row.modified}</span>
      </button>)}
      {/* ListColumnRules markup: no thumbnail divider, one boundary per
          subsequent column and a trailing rule on the last real track. */}
      <div className="cp-lib-colrules" aria-hidden>
        {[0, 1, 2, 3].map((track) => <span key={track} className={track === 3 ? "last-col" : undefined} />)}
      </div>
    </div>
  </div>;
}

export function SurfaceExamples({ kind, size }: ExampleProps) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState("Assembly_v03.mov");
  const [feedback, setFeedback] = useState("empty");
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useModalFocus(open, dialogRef);
  useDismiss(dialogRef, close, open);
  if (kind === "dialogs") return <Comparison current={<div className="cp-ds-stack"><div className="cp-ds-dialog-sketch"><strong>Rename sequence</strong><div className="cp-ds-skeleton" /><div className="cp-ds-inline"><span>Cancel</span><span>Rename</span></div></div><small>Keep task dialogs distinct from persistent inspectors and transient menus.</small></div>} proposed={<div className="cp-ds-stack"><Button size={size} onClick={() => setOpen(true)}>Open example dialog</Button><small role="status">{message || "Escape closes. Focus stays inside and returns to the opener."}</small>{open && createPortal(<div className="cp-ds-modal-backdrop"><div className="cp-ds-dialog" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-description`} tabIndex={-1} ref={dialogRef}><header><h3 id={`${uid}-title`}>Rename sequence</h3><IconButton label="Close example dialog" size="compact" variant="quiet" onClick={close}><IconX size={14} /></IconButton></header><p id={`${uid}-description`}>A catalog-only dialog. Nothing will be written to disk.</p><label className="cp-ds-field">Sequence name<input className="cp-ds-input" defaultValue="Assembly v03" /></label><footer><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={() => { setMessage("Rename demonstrated. No saved data changed."); close(); }}>Rename</Button></footer></div></div>, document.body)}</div>} />;
  if (kind === "tooltips") return <Comparison same current={<div className="cp-ds-stack"><button className="btn-icon" type="button" title="Source information" aria-label="Source information"><IconInfo size={14} /></button><small>Native tooltips remain appropriate for ordinary controls.</small></div>} proposed={<div className="cp-ds-stack"><Tooltip label="Source information"><IconButton label="Source information" variant="quiet" size={size}><IconInfo size={14} /></IconButton></Tooltip><small>Existing contextual tooltip: pointer and keyboard focus; Escape dismisses. Use only where native placement obscures adjacent controls.</small></div>} />;
  if (kind === "panels") return <Comparison related currentBasis="schematic" proposedBasis="component" current={<div className="cp-ds-stack"><div className="cp-ds-panel-sample"><h4>Review notes</h4><p>One persistent working surface, not a stack of nested cards.</p></div><small>Panel-content sketch, not the mounted Review panel.</small></div>} proposed={<div className="cp-ds-disclosure"><CollapsibleSection id={`${uid}-connection`} label="Connection details" summary="Hidden until needed" meta="Local fixture" open={expanded} onToggle={() => setExpanded(!expanded)}><p>1080p · 29.97 fps · stereo</p><p>Latency remains unmeasured. This example contains no live connection.</p></CollapsibleSection><small>Related disclosure component with fixture content, not a replacement panel layout.</small></div>} />;
  if (kind === "tables") {
    const rows = ["Assembly_v03.mov", "Interview_with_a_very_long_descriptive_filename.mov", "Séquence_finale_東京.mov"];
    const table = (interactive: boolean) => <div className="cp-ds-table-wrap"><table className="cp-ds-table"><thead><tr><th scope="col">Name</th><th scope="col">Duration</th><th scope="col">Size</th></tr></thead><tbody>{rows.map((name, i) => <tr key={name} data-selected={selected === name}><th scope="row">{interactive ? <button type="button" aria-pressed={selected === name} title={name} onClick={() => setSelected(name)}><IconFolder size={12} /><span>{name}</span></button> : <span title={name}>{name}</span>}</th><td>{["00:02:43", "00:18:12", "00:01:30"][i]}</td><td>{["428 MB", "2.4 GB", "216 MB"][i]}</td></tr>)}</tbody></table></div>;
    return <><Comparison
      currentBasis="markup"
      proposedBasis="schematic"
      current={<div className="cp-ds-stack">
        <CurrentTable />
        <small>Production grid classes: 27px rows, existing row typography, violet selection, continuous column rules and striped empty floor. Hardcoded data; sorting and selection stay local.</small>
        <strong className="cp-ds-caption">Narrow specimen · 300px maximum</strong>
        <CurrentTable narrow />
        <small>Long names and dates clip inside their cells. No real files, column resizing or drag behavior are connected.</small>
      </div>}
      proposed={<div className="cp-ds-stack">{table(true)}<small>Illustrative semantic-table experiment, not pixel-equivalent to the production grid. It does not retain the existing columns, resize behavior or empty-floor geometry. Adoption requires separate review; this is not a replacement.</small></div>}
    /><ClipTagExamples /></>;
  }
  if (kind === "feedback") return <Comparison current={<div className="cp-ds-stack"><strong>Model downloads · production component</strong><ModelDownloadProgress name="Example model" done={210000000} total={1000000000} /><ModelDownloadProgress name="Unknown-size example" /><small>Fixed fixtures; no downloads. Shared neutral rail, actual percentage or indeterminate state.</small><div className="cp-pane-empty"><strong className="cp-pane-empty-title">No notes yet</strong><p className="cp-pane-empty-body">Add a note when you are ready to review.</p></div></div>} proposed={<div className="cp-ds-stack"><label className="cp-ds-field">Example state<select className="cp-select" value={feedback} onChange={(e) => setFeedback(e.target.value)}>{["empty", "loading", "error", "offline", "success"].map((v) => <option key={v}>{v}</option>)}</select></label><div className="cp-ds-feedback" role="status">{feedback === "empty" ? <><strong>No notes yet</strong><p>Add a note when you are ready to review.</p></> : feedback === "loading" ? <><strong>Loading saved notes…</strong><div className="cp-ds-skeleton" /><div className="cp-ds-skeleton cp-ds-skeleton-short" /></> : feedback === "error" ? <><StatusBadge tone="danger">Could not load notes</StatusBadge><p>Your saved notes have not been changed.</p><Button size="compact" onClick={() => setFeedback("success")}>Retry example</Button></> : feedback === "offline" ? <><StatusBadge tone="warning">Waiting to sync</StatusBadge><p>Your note is saved locally. It will retry when connected.</p></> : <><StatusBadge tone="success">Synced</StatusBadge><p>All example notes are up to date.</p></>}</div></div>} />;
  return <Comparison related currentBasis="schematic" proposedBasis="schematic" current={<div className="cp-ds-type-sample"><h3>Sequence review</h3><p>Body copy supports the work.</p><small>Meaningful secondary information stays readable.</small><span className="cp-ds-timecode">01:02:38:15</span><small>Token-based type specimen, not a production screen excerpt.</small></div>} proposed={<div className="cp-ds-stack"><div className="cp-ds-swatches">{["bg-1", "bg-3", "bg-4", "fg-1", "success", "novella-violet-deep", "danger-text"].map((token) => <div key={token}><span style={{ background: `var(--${token})` }} /><code>{token}</code></div>)}</div><small>Related palette reference using existing tokens, not a before/after type comparison. Nunito Sans, white focus and neutral action emphasis remain the baseline.</small></div>} />;
}
