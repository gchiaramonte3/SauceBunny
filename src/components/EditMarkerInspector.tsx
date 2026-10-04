import type { TimelineMarker } from "../lib/edit-document";
import { MARKER_COLORS } from "../lib/edit-stringout";

type Props = {
  marker: TimelineMarker; tc: (seconds: number) => string;
  onChange: (change: Partial<Pick<TimelineMarker, "name" | "comment" | "color">>) => void; onRemove: () => void; onDone: () => void;
};

const title = (color: string) => color.charAt(0).toUpperCase() + color.slice(1);

/**
 * The marker clicked on the ruler: its name, its comment and one of Media
 * Composer's eight colours, which is what an exported marker carries. Typing
 * is one undo step per field, not one per letter.
 */
export function EditMarkerInspector({ marker, tc, onChange, onRemove, onDone }: Props) {
  return <section className="cp-te-insp-section" aria-labelledby="cp-te-insp-marker">
    <h3 id="cp-te-insp-marker" className="cp-te-insp-title">Marker at {tc(marker.at)}</h3>
    <label className="cp-te-set-label cp-te-insp-field">Name
      <input className="cp-input cp-te-insp-input" value={marker.name} onChange={(event) => onChange({ name: event.target.value })} />
    </label>
    <label className="cp-te-set-label cp-te-insp-field">Comment
      <textarea className="cp-input cp-te-insp-input" rows={3} value={marker.comment} onChange={(event) => onChange({ comment: event.target.value })} />
    </label>
    <label className="cp-te-set-label cp-te-insp-field">Colour
      <select className="cp-select cp-te-insp-input" value={MARKER_COLORS.includes(marker.color) ? marker.color : "red"} onChange={(event) => onChange({ color: event.target.value })}>
        {MARKER_COLORS.map((color) => <option key={color} value={color}>{title(color)}</option>)}
      </select>
    </label>
    <div className="cp-te-insp-actions">
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={onRemove} title="Delete this marker (Delete, on the marker)">Delete marker</button>
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={onDone}>Done</button>
    </div>
  </section>;
}
