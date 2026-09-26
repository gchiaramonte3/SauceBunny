import type { AafTrackLabel } from "../bindings/AafTrackLabel";
import { assignedMarkerColor, AVID_COLORS, CAST_GENDERS, isGender, isMarkerColor, preferenceLabel } from "../lib/cast-marker";

export type MicPreferences = Pick<AafTrackLabel, "gender" | "marker_color">;
export type RenameMic = (id: string, name: string, memberId?: string | null, color?: string | null, preferences?: MicPreferences) => void;
export function CastMarkerFields({ name, value, onChange }: { name: string; value: MicPreferences; onChange: (value: MicPreferences) => void }) {
  return <div className="cp-cast-marker-fields">
    <select className="cp-select" aria-label={`Gender for ${name}`} value={value.gender ?? "unspecified"} onChange={(event) => {
      const gender = event.target.value; if (isGender(gender)) onChange({ gender, marker_color: assignedMarkerColor(gender, value.marker_color) });
    }}>{CAST_GENDERS.map((gender) => <option key={gender} value={gender}>{preferenceLabel(gender)}</option>)}</select>
    <select className="cp-select" aria-label={`Avid marker color for ${name}`} value={value.marker_color ?? ""} onChange={(event) => {
      const color = event.target.value; if (isMarkerColor(color)) onChange({ ...value, marker_color: color });
    }}><option value="" disabled>Default color</option>{AVID_COLORS.map((color) => <option key={color} value={color}>{preferenceLabel(color)}</option>)}</select>
  </div>;
}
