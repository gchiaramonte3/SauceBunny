import { useRef, useState, type ReactNode } from "react";
import { Icon, IconChevronDown, IconMarkIn, IconMarkOut, IconScissors } from "./Icons";
import { useDismiss } from "../hooks/use-dismiss";
import { TIMELINE_MAX_PX_PER_FRAME, TIMELINE_MIN_PX_PER_FRAME } from "../lib/edit-timeline-scale";
import type { RecordTool } from "../hooks/use-record-gestures";
import { useMenuKeys } from "../hooks/use-menu-keys";

export type EditTrackHeight = "small" | "medium" | "large";
export type EditTimelineView = { waveforms: boolean; speakerColours: boolean; height: EditTrackHeight };
export type EditTimelineAudio = { crossfade: 0 | 1 | 2 | 4 };

type Props = {
  marks: { in: number | null; out: number | null };
  /** Clear both marks (G), drawn as a × on the ruler's marked range rather than in this row. */
  onClearMarks?: () => void;
  /** Audio ▸ Strip Silence…, which opens Media Composer's settings for it. */
  onStripSilence?: () => void;
  /** Audio ▸ Stack Conversations: each back-and-forth as one clip with everyone in it on their own track. */
  onStackConversations?: () => void;
  /** Audio ▸ Focus on Marked Lines: in each clip with a marker on a person, everyone else is muted. */
  onFocusMarked?: () => void;
  canMark: boolean; snap: boolean; follow: boolean; loop: boolean; finding: boolean;
  /** Why dead space cannot be found yet, or undefined when it can. */
  deadHint?: string;
  hasPrevious: boolean; hasNext: boolean;
  /** The timeline shows the source: the edits that change the string out rest until it shows Record again. */
  sourceSide?: boolean;
  /** Match Frame (⇧F): the record clip under the playhead, opened in the source on the same frame. */
  onMatchFrame?: () => void;
  onAddEdit: () => void; onMarkIn: () => void; onMarkClip: () => void; onFindDead: () => void; onMarkOut: () => void; onLift: () => void; onExtract: () => void; onMarker: () => void;
  onSnap: () => void; onFollow: () => void; onLoop: () => void; onPrevious: () => void; onNext: () => void;
  allText: boolean; onAllText: () => void;
  view: EditTimelineView; onView: (view: EditTimelineView) => void; measuring: boolean;
  audio: EditTimelineAudio; onAudio: (audio: EditTimelineAudio) => void;
  /** Pixels per frame. */
  zoom: number; onZoom: (direction: -1 | 0 | 1) => void;
  /** The record tools, after Neo's: which is in hand, Trim (U) and whether one-sided trims ripple (⇧R). */
  tool: RecordTool; onTool: (tool: RecordTool) => void; trimming: boolean; onTrim: () => void; ripple: boolean; onRipple: () => void;
};

const IconLift = () => <Icon size={15}><path d="M4 18h5M15 18h5" /><path d="M12 15V5M8.5 8.5 12 5l3.5 3.5" /></Icon>;
const IconExtract = () => <Icon size={15}><path d="M3 18h6M15 18h6" /><path d="M9 13l3 3 3-3M12 5v11" /></Icon>;
const IconMatchFrame = () => <Icon size={15}><rect x="3" y="6" width="8" height="12" rx="1" /><rect x="13" y="6" width="8" height="12" rx="1" /><path d="M7 12h10M14.5 9.5 17 12l-2.5 2.5" /></Icon>;
const IconMarkClip = () => <Icon size={15}><path d="M5 5v14M19 5v14" /><rect x="8" y="8" width="8" height="8" rx="1" /></Icon>;
const IconDeadSpace = () => <Icon size={15}><path d="M3 12h3M18 12h3" /><path d="M8 9v6M10 7v10M14 7v10M16 9v6" /><path d="M11.5 4v16" strokeDasharray="2 2" /></Icon>;
const IconMarker = () => <Icon size={15}><path d="M7 4h10v16l-5-4-5 4z" /></Icon>;
const IconSnap = () => <Icon size={15}><path d="M6 4v8a6 6 0 0 0 12 0V4" /><path d="M6 8h4M14 8h4" /></Icon>;
const IconFollow = () => <Icon size={15}><path d="M8 4v16" /><path d="M12 12h8M17 9l3 3-3 3" /></Icon>;
const IconLoop = () => <Icon size={15}><path d="M17 3l3 3-3 3" /><path d="M4 11V9a3 3 0 0 1 3-3h13" /><path d="M7 21l-3-3 3-3" /><path d="M20 13v2a3 3 0 0 1-3 3H4" /></Icon>;
const IconSelect = () => <Icon size={15}><path d="M6 4l12 7-5 1.5L10.5 18z" /></Icon>;
const IconBlade = () => <Icon size={15}><path d="M12 3v18" strokeDasharray="2 2" /><path d="M9 7l3-4 3 4z" /></Icon>;
const IconRoll = () => <Icon size={15}><path d="M12 4v16" /><path d="M8 8v8M16 8v8" /><path d="M5 12h2M17 12h2" /></Icon>;
const IconSlip = () => <Icon size={15}><rect x="7" y="7" width="10" height="10" rx="1" /><path d="M4 12h3M17 12h3M10 12h4" /></Icon>;
const IconSlide = () => <Icon size={15}><path d="M4 8v8M20 8v8" /><rect x="8" y="8" width="8" height="8" rx="1" /><path d="M5 12h2M17 12h2" /></Icon>;
const IconTrim = () => <Icon size={15}><path d="M9 4v16M15 4v16" /><path d="M5 9l3 3-3 3M19 9l-3 3 3 3" /></Icon>;
const IconRipple = () => <Icon size={15}><path d="M4 7h8v10H4z" /><path d="M15 12h5M17.5 9.5 20 12l-2.5 2.5" /></Icon>;
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
 * The timeline's one row of tools, and only tools: the owner asked for "just
 * timeline tools" (October 5). Play, the timecodes and the editor's status
 * live in the panes above. Icons with tooltips, no heading and no prose:
 * every item names its shortcut in the tooltip, and the display options live
 * behind two menus so the row stays short. No people here, ever.
 */
export function EditTimelineTools(props: Props) {
  const { marks, view, audio } = props;
  const ranged = marks.in != null && marks.out != null && marks.out > marks.in;
  // Only In and Out act on the source, as in Avid's source monitor; the rest edit the record.
  const record = props.sourceSide ? { hint: "Switch the timeline to Record to use it", off: true } : { hint: undefined, off: false };
  return <div className="cp-te-tl-tools" role="toolbar" aria-label="Timeline tools">
    <div className="cp-te-tl-group">
      <Tool label="Add edit at playhead" keys="⌘B" hint={record.hint} disabled={record.off || !props.canMark} onClick={props.onAddEdit}><IconScissors size={15} /></Tool>
      <Tool label="Mark in" keys="I" pressed={marks.in != null} onClick={props.onMarkIn}><IconMarkIn size={15} /></Tool>
      <Tool label="Mark out" keys="O" pressed={marks.out != null} onClick={props.onMarkOut}><IconMarkOut size={15} /></Tool>
      <Tool label="Mark clip" keys="T" hint={record.hint} disabled={record.off || !props.canMark} onClick={props.onMarkClip}><IconMarkClip /></Tool>
      {props.onMatchFrame && <Tool label="Match frame" keys="⇧F" hint={record.hint} disabled={record.off || !props.canMark} onClick={props.onMatchFrame}><IconMatchFrame /></Tool>}
      <Tool label="Lift in to out on selected tracks" keys="Z" hint={record.hint} disabled={record.off || !ranged} onClick={props.onLift}><IconLift /></Tool>
      <Tool label="Extract in to out, all tracks" keys="X" hint={record.hint} disabled={record.off || !ranged} onClick={props.onExtract}><IconExtract /></Tool>
      <Tool label="Add marker" keys="M" hint={record.hint} disabled={record.off} onClick={props.onMarker}><IconMarker /></Tool>
      <Tool label="Remove dead space" hint={record.hint ?? props.deadHint} pressed={props.finding} disabled={record.off || !props.canMark || (!!props.deadHint && !props.finding)} onClick={props.onFindDead}><IconDeadSpace /></Tool>
    </div>
    <span className="cp-te-tl-sep" aria-hidden="true" />
    <div className="cp-te-tl-group">
      <Tool label="Snap" pressed={props.snap} onClick={props.onSnap}><IconSnap /></Tool>
      <Tool label="Follow playhead" pressed={props.follow} onClick={props.onFollow}><IconFollow /></Tool>
      <Tool label={ranged ? "Loop in to out" : "Loop"} keys="⌘L" pressed={props.loop} onClick={props.onLoop}><IconLoop /></Tool>
    </div>
    <span className="cp-te-tl-sep" aria-hidden="true" />
    {/* The record tools, as Neo's palette: one in hand at a time, plus Trim and the ripple switch. */}
    <div className="cp-te-tl-group">
      <Tool label="Selection tool" keys="⇧A" hint={record.hint} pressed={!record.off && props.tool === "select"} disabled={record.off} onClick={() => props.onTool("select")}><IconSelect /></Tool>
      <Tool label="Blade tool" keys="C" hint={record.hint} pressed={!record.off && props.tool === "blade"} disabled={record.off} onClick={() => props.onTool("blade")}><IconBlade /></Tool>
      <Tool label="Roll tool" keys="N" hint={record.hint} pressed={!record.off && props.tool === "roll"} disabled={record.off} onClick={() => props.onTool("roll")}><IconRoll /></Tool>
      <Tool label="Slip tool" keys="Y" hint={record.hint} pressed={!record.off && props.tool === "slip"} disabled={record.off} onClick={() => props.onTool("slip")}><IconSlip /></Tool>
      <Tool label="Slide tool" keys="R" hint={record.hint} pressed={!record.off && props.tool === "slide"} disabled={record.off} onClick={() => props.onTool("slide")}><IconSlide /></Tool>
      <Tool label="Trim" keys="U" hint={record.hint} pressed={props.trimming} disabled={record.off || !props.canMark} onClick={props.onTrim}><IconTrim /></Tool>
      <Tool label="Ripple trims" keys="⇧R" hint={record.hint} pressed={props.ripple} disabled={record.off} onClick={props.onRipple}><IconRipple /></Tool>
    </div>
    <span className="cp-te-tl-sep" aria-hidden="true" />
    <div className="cp-te-tl-group">
      <Tool label="Previous edit" keys="A" hint={record.hint} disabled={record.off || !props.hasPrevious} onClick={props.onPrevious}><IconPrevEdit /></Tool>
      <Tool label="Next edit" keys="S" hint={record.hint} disabled={record.off || !props.hasNext} onClick={props.onNext}><IconNextEdit /></Tool>
    </div>
    <div className="cp-te-tl-end">
      <Menu label="View">{() => <>
        <Check checked={view.waveforms} onChange={() => props.onView({ ...view, waveforms: !view.waveforms })}>{props.measuring ? "Waveforms (building)" : "Waveforms"}</Check>
        <Check checked={view.speakerColours} onChange={() => props.onView({ ...view, speakerColours: !view.speakerColours })}>Speaker colours</Check>
        <Check checked={props.allText} onChange={props.onAllText}>Text on every track</Check>
        <div className="cp-popover-header" role="presentation">Track height</div>
        {(["small", "medium", "large"] as const).map((height) => <Radio key={height} checked={view.height === height} onChoose={() => props.onView({ ...view, height })}>
          {height[0].toUpperCase() + height.slice(1)}</Radio>)}
      </>}</Menu>
      <Menu label="Audio">{(close) => <>
        <div className="cp-popover-header" role="presentation">Crossfade at cuts (playback only)</div>
        {([0, 1, 2, 4] as const).map((frames) => <Radio key={frames} checked={audio.crossfade === frames} onChoose={() => props.onAudio({ ...audio, crossfade: frames })}>
          {frames ? `${frames} ${frames === 1 ? "frame" : "frames"}` : "Off"}</Radio>)}
        {props.onStripSilence && <button type="button" role="menuitem" className="cp-popover-item" disabled={record.off} title={record.hint ?? "Silence the quiet stretches on the selected tracks, as Media Composer's Strip Silence does"}
          onClick={() => { close(); props.onStripSilence?.(); }}><span className="lbl">Strip Silence…</span></button>}
        {props.onStackConversations && <button type="button" role="menuitem" className="cp-popover-item" disabled={record.off}
          title={record.hint ?? "Stack conversations: play everyone in a back-and-forth on their own track, in sync, instead of one track per bite with filler between"}
          onClick={() => { close(); props.onStackConversations?.(); }}><span className="lbl">Stack Conversations</span></button>}
        {props.onFocusMarked && <button type="button" role="menuitem" className="cp-popover-item" disabled={record.off}
          title={record.hint ?? "Focus on marked lines: in each clip with a marker on a person, mute everyone else in it, so the line can be heard over the room"}
          onClick={() => { close(); props.onFocusMarked?.(); }}><span className="lbl">Focus on Marked Lines</span></button>}
      </>}</Menu>
      <div className="cp-te-tl-zoom" role="group" aria-label="Zoom">
        <button type="button" className="cp-icon-btn" aria-label="Zoom out" title="Zoom out (⌘−)" disabled={props.zoom <= TIMELINE_MIN_PX_PER_FRAME} onClick={() => props.onZoom(-1)}>−</button>
        <button type="button" className="btn btn-ghost cp-te-btn cp-te-tl-fit" title="Fit (⇧Z)" onClick={() => props.onZoom(0)}>Fit</button>
        <button type="button" className="cp-icon-btn" aria-label="Zoom in" title="Zoom in (⌘=)" disabled={props.zoom >= TIMELINE_MAX_PX_PER_FRAME} onClick={() => props.onZoom(1)}>+</button>
      </div>
    </div>
  </div>;
}
