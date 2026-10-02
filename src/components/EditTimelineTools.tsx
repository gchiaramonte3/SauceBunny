import { useRef, useState, type ReactNode } from "react";
import { Icon, IconChevronDown, IconMarkIn, IconMarkOut, IconScissors } from "./Icons";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";

export type EditTrackHeight = "small" | "medium" | "large";
export type EditTimelineView = { waveforms: boolean; speakerColours: boolean; height: EditTrackHeight };
export type EditTimelineAudio = { crossfade: 0 | 1 | 2 | 4; roomTone: boolean };

type Props = {
  /** Play and the Record/Source readouts, which lead the row. */
  transport?: ReactNode;
  /** The last thing the editor did ("Lifted 2.40 s."), announced politely. */
  status?: string;
  marks: { in: number | null; out: number | null };
  canMark: boolean; snap: boolean; follow: boolean; loop: boolean; finding: boolean;
  /** Why dead space cannot be found yet, or undefined when it can. */
  deadHint?: string;
  hasPrevious: boolean; hasNext: boolean;
  /** The timeline shows the source: the edits that change the string out rest until it shows Record again. */
  sourceSide?: boolean;
  onAddEdit: () => void; onMarkIn: () => void; onMarkClip: () => void; onFindDead: () => void; onMarkOut: () => void; onLift: () => void; onExtract: () => void; onMarker: () => void;
  onSnap: () => void; onFollow: () => void; onLoop: () => void; onPrevious: () => void; onNext: () => void;
  allText: boolean; onAllText: () => void;
  view: EditTimelineView; onView: (view: EditTimelineView) => void; measuring: boolean;
  audio: EditTimelineAudio; onAudio: (audio: EditTimelineAudio) => void;
  zoom: number; onZoom: (direction: -1 | 0 | 1) => void;
};

const IconLift = () => <Icon size={15}><path d="M4 18h5M15 18h5" /><path d="M12 15V5M8.5 8.5 12 5l3.5 3.5" /></Icon>;
const IconExtract = () => <Icon size={15}><path d="M3 18h6M15 18h6" /><path d="M9 13l3 3 3-3M12 5v11" /></Icon>;
const IconMarkClip = () => <Icon size={15}><path d="M5 5v14M19 5v14" /><rect x="8" y="8" width="8" height="8" rx="1" /></Icon>;
const IconDeadSpace = () => <Icon size={15}><path d="M3 12h3M18 12h3" /><path d="M8 9v6M10 7v10M14 7v10M16 9v6" /><path d="M11.5 4v16" strokeDasharray="2 2" /></Icon>;
const IconMarker = () => <Icon size={15}><path d="M7 4h10v16l-5-4-5 4z" /></Icon>;
const IconSnap = () => <Icon size={15}><path d="M6 4v8a6 6 0 0 0 12 0V4" /><path d="M6 8h4M14 8h4" /></Icon>;
const IconFollow = () => <Icon size={15}><path d="M8 4v16" /><path d="M12 12h8M17 9l3 3-3 3" /></Icon>;
const IconLoop = () => <Icon size={15}><path d="M17 3l3 3-3 3" /><path d="M4 11V9a3 3 0 0 1 3-3h13" /><path d="M7 21l-3-3 3-3" /><path d="M20 13v2a3 3 0 0 1-3 3H4" /></Icon>;
const IconPrevEdit = () => <Icon size={15}><path d="M6 5v14" /><path d="M17 6l-6 6 6 6" /></Icon>;
const IconNextEdit = () => <Icon size={15}><path d="M18 5v14" /><path d="M7 6l6 6-6 6" /></Icon>;

function Tool({ label, keys, hint, pressed, disabled, onClick, children }: { label: string; keys?: string; hint?: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={`cp-icon-btn cp-te-tool${pressed ? " active" : ""}`} aria-label={label} title={`${keys ? `${label} (${keys})` : label}${hint ? `. ${hint}` : ""}`}
    aria-pressed={pressed} aria-keyshortcuts={keys} disabled={disabled} onClick={onClick}>{children}</button>;
}

/** A chevron menu over the tool row: opens upward, since the timeline sits at the bottom of the window. */
function Menu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null);
  useDismiss(box, () => setOpen(false), open);
  useMenuKeys(menu, open, () => setOpen(false));
  return <div ref={box} className="cp-view-options cp-te-tl-menu">
    <button type="button" className={`cp-view-trigger${open ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className="label">{label}</span><IconChevronDown size={12} /></button>
    {open && <div ref={menu} className="cp-view-popover" role="menu" aria-label={label}>{children(() => setOpen(false))}</div>}
  </div>;
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return <button type="button" role="menuitemcheckbox" aria-checked={checked} className={`cp-popover-item${checked ? " active" : ""}`} onClick={onChange}>
    <span className="lbl">{children}</span></button>;
}

function Radio({ checked, onChoose, children }: { checked: boolean; onChoose: () => void; children: ReactNode }) {
  return <button type="button" role="menuitemradio" aria-checked={checked} className={`cp-popover-item${checked ? " active" : ""}`} onClick={onChoose}>
    <span className="lbl">{children}</span></button>;
}

/**
 * The timeline's one row of tools. Icons with tooltips, no heading and no
 * prose: every item names its shortcut in the tooltip, and the display
 * options live behind two menus so the row stays short.
 */
export function EditTimelineTools(props: Props) {
  const { marks, view, audio } = props;
  const ranged = marks.in != null && marks.out != null && marks.out > marks.in;
  // Only In and Out act on the source, as in Avid's source monitor; the rest edit the record.
  const record = props.sourceSide ? { hint: "Switch the timeline to Record to use it", off: true } : { hint: undefined, off: false };
  return <div className="cp-te-tl-tools" role="toolbar" aria-label="Timeline tools">
    {props.transport && <>{props.transport}<span className="cp-te-tl-sep" aria-hidden="true" /></>}
    <div className="cp-te-tl-group">
      <Tool label="Add edit at playhead" keys="⌘B" hint={record.hint} disabled={record.off || !props.canMark} onClick={props.onAddEdit}><IconScissors size={15} /></Tool>
      <Tool label="Mark in" keys="I" pressed={marks.in != null} onClick={props.onMarkIn}><IconMarkIn size={15} /></Tool>
      <Tool label="Mark out" keys="O" pressed={marks.out != null} onClick={props.onMarkOut}><IconMarkOut size={15} /></Tool>
      <Tool label="Mark clip" keys="T" hint={record.hint} disabled={record.off || !props.canMark} onClick={props.onMarkClip}><IconMarkClip /></Tool>
      <Tool label="Lift in to out on selected tracks" keys="Z" hint={record.hint} disabled={record.off || !ranged} onClick={props.onLift}><IconLift /></Tool>
      <Tool label="Extract in to out, all tracks" keys="X" hint={record.hint} disabled={record.off || !ranged} onClick={props.onExtract}><IconExtract /></Tool>
      <Tool label="Add marker" keys="M" hint={record.hint} disabled={record.off} onClick={props.onMarker}><IconMarker /></Tool>
      <Tool label="Remove dead space" hint={record.hint ?? props.deadHint} pressed={props.finding} disabled={record.off || !props.canMark || (!!props.deadHint && !props.finding)} onClick={props.onFindDead}><IconDeadSpace /></Tool>
    </div>
    <span className="cp-te-tl-sep" aria-hidden="true" />
    <div className="cp-te-tl-group">
      <Tool label="Snap" keys="N" pressed={props.snap} onClick={props.onSnap}><IconSnap /></Tool>
      <Tool label="Follow playhead" pressed={props.follow} onClick={props.onFollow}><IconFollow /></Tool>
      <Tool label={ranged ? "Loop in to out" : "Loop"} keys="⌘L" pressed={props.loop} onClick={props.onLoop}><IconLoop /></Tool>
    </div>
    <span className="cp-te-tl-sep" aria-hidden="true" />
    <div className="cp-te-tl-group">
      <Tool label="Previous edit" keys="A" hint={record.hint} disabled={record.off || !props.hasPrevious} onClick={props.onPrevious}><IconPrevEdit /></Tool>
      <Tool label="Next edit" keys="S" hint={record.hint} disabled={record.off || !props.hasNext} onClick={props.onNext}><IconNextEdit /></Tool>
    </div>
    <p className="cp-te-status" role="status" aria-live="polite">{props.status}</p>
    <div className="cp-te-tl-end">
      <Menu label="View">{() => <>
        <Check checked={view.waveforms} onChange={() => props.onView({ ...view, waveforms: !view.waveforms })}>{props.measuring ? "Waveforms (building)" : "Waveforms"}</Check>
        <Check checked={view.speakerColours} onChange={() => props.onView({ ...view, speakerColours: !view.speakerColours })}>Speaker colours</Check>
        <Check checked={props.allText} onChange={props.onAllText}>Text on every track</Check>
        <div className="cp-popover-header" role="presentation">Track height</div>
        {(["small", "medium", "large"] as const).map((height) => <Radio key={height} checked={view.height === height} onChoose={() => props.onView({ ...view, height })}>
          {height[0].toUpperCase() + height.slice(1)}</Radio>)}
      </>}</Menu>
      <Menu label="Audio">{() => <>
        <div className="cp-popover-header" role="presentation">Crossfade at cuts</div>
        {([0, 1, 2, 4] as const).map((frames) => <Radio key={frames} checked={audio.crossfade === frames} onChoose={() => props.onAudio({ ...audio, crossfade: frames })}>
          {frames ? `${frames} ${frames === 1 ? "frame" : "frames"}` : "Off"}</Radio>)}
        <Check checked={audio.roomTone} onChange={() => props.onAudio({ ...audio, roomTone: !audio.roomTone })}>Room tone in lifts</Check>
      </>}</Menu>
      <div className="cp-te-tl-zoom" role="group" aria-label="Zoom">
        <button type="button" className="cp-icon-btn" aria-label="Zoom out" title="Zoom out (⌘−)" disabled={props.zoom <= 1} onClick={() => props.onZoom(-1)}>−</button>
        <button type="button" className="btn btn-ghost cp-te-btn cp-te-tl-fit" title="Fit (⇧Z)" disabled={props.zoom === 1} onClick={() => props.onZoom(0)}>Fit</button>
        <button type="button" className="cp-icon-btn" aria-label="Zoom in" title="Zoom in (⌘=)" disabled={props.zoom >= 32} onClick={() => props.onZoom(1)}>+</button>
      </div>
    </div>
  </div>;
}
