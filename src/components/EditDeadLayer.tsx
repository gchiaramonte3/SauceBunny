import type { EditDeadReview } from "./EditDeadSpaceBar";

type Props = { review: EditDeadReview; x: (t: number) => string; w: (d: number) => string; at: (seconds: number) => string; onSkip: (index: number) => void };

/** The dead space found, drawn over the lanes: click a span to keep it. */
export function EditDeadLayer({ review, x, w, at, onSkip }: Props) {
  return <div className="cp-te-tl-deadlayer">
    {review.spaces.map((space, index) => <button key={index} type="button" className="cp-te-tl-dead" aria-pressed={!review.skip.has(index)}
      style={{ left: x(space.from), width: w(space.to - space.from) }} aria-label={`${(space.to - space.from).toFixed(1)} s at ${at(space.from)}`}
      title={review.skip.has(index) ? "Kept. Click to remove" : "Removing. Click to keep"} onClick={() => onSkip(index)} />)}
  </div>;
}
