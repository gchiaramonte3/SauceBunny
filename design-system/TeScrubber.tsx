import { useRef } from "react";

type Props = {
  label: string; value: number; max: number; text: string;
  /** Where the edit points are, drawn as ticks on the rail. */
  marks?: number[];
  onScrub: (value: number) => void; onScrubStart?: () => void; onScrubEnd?: () => void;
};

/**
 * A scrub rail: grab anywhere and drag, and the position follows the pointer
 * on every move, not just on release. Playback pauses while you hold it and
 * picks up again when you let go (the owner decides, through onScrubStart
 * and onScrubEnd). Arrow keys step a second, Shift five, Home and End go to
 * the ends. The rail is its own element, so a drag that leaves it keeps going.
 */
export function TeScrubber({ label, value, max, text, marks = [], onScrub, onScrubStart, onScrubEnd }: Props) {
  const rail = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  const span = Math.max(0.001, max);
  const at = (clientX: number) => {
    const box = rail.current!.getBoundingClientRect();
    return Math.max(0, Math.min(max, ((clientX - box.left) / box.width) * max));
  };
  const end = () => { if (held.current) { held.current = false; onScrubEnd?.(); } };
  return <div ref={rail} className="cp-te-scrub" role="slider" tabIndex={0} aria-label={label}
    aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={text}
    title={label}
    style={{ "--te-at": `${(Math.min(value, max) / span) * 100}%` } as React.CSSProperties}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      held.current = true;
      onScrubStart?.();
      onScrub(at(event.clientX));
    }}
    onPointerMove={(event) => { if (held.current) onScrub(at(event.clientX)); }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 5 : 1;
      const next = event.key === "ArrowRight" ? value + step : event.key === "ArrowLeft" ? value - step
        : event.key === "Home" ? 0 : event.key === "End" ? max : null;
      if (next == null) return;
      event.preventDefault();
      event.stopPropagation();
      onScrub(Math.max(0, Math.min(max, next)));
    }}>
    <span className="cp-te-scrub-track" aria-hidden="true">
      {marks.map((mark, index) => <span key={index} className="cp-te-scrub-mark" style={{ left: `${(mark / span) * 100}%` }} />)}
      <span className="cp-te-scrub-fill" />
      <span className="cp-te-scrub-thumb" />
    </span>
  </div>;
}
