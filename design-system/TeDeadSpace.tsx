import type { TeDeadSpace } from "./transcript-editor-model";

/**
 * Two ways to take out dead space, from what editors already use: Descript
 * shortens word gaps over 0.5 s to 0.25 s, and a reality edit wants only the
 * real dead air gone, leaving a half-second beat so a reaction can land.
 * Shorten, never delete outright: Premiere's pause removal can only delete,
 * and "reduce to" is its most-asked-for missing option.
 */
export type TeDeadPreset = "air" | "tight";
export const teDeadPresets: Record<TeDeadPreset, { label: string; minimum: number; keep: number }> = {
  air: { label: "Dead air", minimum: 1.5, keep: 0.5 },
  tight: { label: "Tighten", minimum: 0.5, keep: 0.25 },
};
export type TeDeadReview = { spaces: TeDeadSpace[]; skip: Set<number>; preset: TeDeadPreset };

type Props = { review: TeDeadReview; onPreset: (preset: TeDeadPreset) => void; onApply: () => void; onCancel: () => void };

/** The review row: what was found, which preset, and one step to apply it. */
export function TeDeadSpaceBar({ review, onPreset, onApply, onCancel }: Props) {
  const chosen = review.spaces.filter((_, index) => !review.skip.has(index));
  const keep = teDeadPresets[review.preset].keep;
  const seconds = chosen.reduce((sum, space) => sum + Math.max(0, space.to - space.from - (space.gap ? 0 : keep)), 0);
  const presets = Object.keys(teDeadPresets) as TeDeadPreset[];
  return <div className="cp-te-dead" role="group" aria-label="Dead space">
    <div className="cp-segmented cp-te-dead-seg" role="radiogroup" aria-label="Dead space preset"
      style={{ "--seg-count": presets.length, "--seg-active": presets.indexOf(review.preset) } as React.CSSProperties}>
      {presets.map((preset) => <button key={preset} type="button" role="radio" aria-checked={preset === review.preset}
        className={preset === review.preset ? "active" : undefined} title={`${teDeadPresets[preset].minimum} s or longer, leave ${teDeadPresets[preset].keep} s`}
        onClick={() => onPreset(preset)}>{teDeadPresets[preset].label}</button>)}
    </div>
    <span className="cp-te-dead-count" role="status">{chosen.length} of {review.spaces.length} · −{seconds.toFixed(1)} s</span>
    <button type="button" className="btn cp-te-btn" disabled={!chosen.length} onClick={onApply}>Remove</button>
    <button type="button" className="btn btn-ghost cp-te-btn" onClick={onCancel}>Cancel</button>
  </div>;
}
