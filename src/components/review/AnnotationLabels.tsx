import type { AnnotationLabel } from "../../lib/review";

/**
 * Read-only chip layer for annotation text labels — a leader dot at the
 * normalized anchor point plus the text on a dark scrim, tinted with the
 * reviewer's colour. Positions scale with the video box (percent offsets,
 * like stroke points); the font size does NOT scale, staying readable at
 * any monitor size. Pointer-transparent so the video/canvas stay usable.
 */
export function AnnotationLabels({ labels, color }: { labels: AnnotationLabel[]; color: string }) {
  if (labels.length === 0) return null;
  return (
    <>
      {labels.map((l, i) => (
        <div
          key={i}
          // Chips near the right edge flip to the left of their anchor so the
          // text never runs off the frame.
          className={"cp-annot-label" + (l.x > 0.72 ? " flip" : "")}
          style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%`, ["--label-color" as string]: color }}
        >
          <span className="cp-annot-label-dot" aria-hidden />
          <span className="cp-annot-label-text">{l.text}</span>
        </div>
      ))}
    </>
  );
}
