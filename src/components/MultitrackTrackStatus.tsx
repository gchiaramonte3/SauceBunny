import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import { useDismiss } from "../hooks/use-dismiss";
import { passagesToReview } from "../lib/multitrack";
import { plural } from "../lib/plural";
import { IconAlert, IconCircleCheck, IconInfo } from "./Icons";

/**
 * The glyph beside a mic owner's name, and what it means on a click. It used
 * to be a hover title only, so an orange "!" after a run read as an error
 * nobody could ask about. It means one of three things: saved; saved with
 * passages to review (the engine returned text with no usable time, so it is
 * kept off the timeline, nothing lost); or no speech found.
 */
export function MultitrackTrackStatus({ transcript, owner, duration, onReview, onInfo }: {
  transcript?: AafTrackTranscript; owner: string; duration: number;
  /** Show this track's passages that need timing review in the Transcript panel. */
  onReview?: (trackId: string) => void;
  /** Open Transcript info, the run's details. */
  onInfo?: () => void;
}) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId();
  const close = useCallback(() => { setOpen(false); trigger.current?.focus(); }, []);
  useDismiss(panel, close, open);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), bounds = panel.current?.getBoundingClientRect();
      if (anchor && bounds) setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8)) });
    };
    place(); panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  if (!transcript) return <span className="cp-multitrack-saved-status" aria-hidden="true" />;
  const review = passagesToReview(transcript);
  const kind = review > 0 ? "review" : transcript.status === "empty" ? "empty" : "saved";
  const gaps = transcript.gaps?.length ?? 0;
  const partial = gaps ? `Selected ranges transcribed, ${plural(gaps, "gap", "gaps")} left out`
    : transcript.start_frame > 0 || transcript.duration_frames < duration ? "Selected range transcribed" : null;
  const title = kind === "review" ? "Timing needs review" : kind === "empty" ? "No speech found" : "Transcript saved";
  // A part of the track is named in the label too, so nothing reads as covering the whole sequence when it does not.
  const label = `${owner}: ${title}${partial ? `. ${partial}` : ""}.`;
  return <>
    <button ref={trigger} type="button" className={`cp-multitrack-saved-status ${kind === "review" ? "needs-review" : kind === "empty" ? "is-empty" : "is-saved"}`}
      aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseDown={(event) => event.stopPropagation()} onClick={() => { if (open) close(); else setOpen(true); }}>
      {kind === "review" ? <IconAlert size={16} /> : kind === "empty" ? <IconInfo size={16} /> : <IconCircleCheck size={16} />}
    </button>
    {open && createPortal(<div ref={panel} id={id} className="cp-multitrack-status-popover" role="dialog" aria-label={label} style={position}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <h3>{title}</h3>
      <p>{kind === "review"
        ? `${plural(review, "passage was", "passages were")} saved without a place on the timeline: the engine gave ${review === 1 ? "it" : "them"} no time, or a time outside the audio it was given. The words are kept; nothing is lost.`
        : kind === "empty" ? "The engine heard no words on this mic. The result is saved, so it is not transcribed again unless you ask."
          : `${owner}'s words are saved and placed on the timeline.`}</p>
      <p className="cp-multitrack-status-meta">{partial ?? "Whole sequence transcribed"} · {transcript.engine} · {transcript.model_id}</p>
      <div className="cp-multitrack-status-actions">
        {kind === "review" && onReview && <button type="button" className="btn" onClick={() => { setOpen(false); onReview(transcript.track_id); }}>Review {plural(review, "passage", "passages")}</button>}
        {onInfo && <button type="button" className="btn btn-ghost" onClick={() => { setOpen(false); onInfo(); }}>Transcript info</button>}
      </div>
    </div>, document.body)}
  </>;
}
