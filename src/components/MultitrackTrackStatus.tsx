import { useId, useRef, useState } from "react";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import { passagesToReview } from "../lib/multitrack";
import { plural } from "../lib/plural";
import { AnchoredPopover } from "./AnchoredPopover";
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
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null), id = useId();
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
      onMouseDown={(event) => event.stopPropagation()} onClick={() => setOpen((value) => !value)}>
      {kind === "review" ? <IconAlert size={16} /> : kind === "empty" ? <IconInfo size={16} /> : <IconCircleCheck size={16} />}
    </button>
    {open && <AnchoredPopover anchor={trigger} id={id} className="cp-multitrack-status-popover" label={label} onClose={() => setOpen(false)}>
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
    </AnchoredPopover>}
  </>;
}
