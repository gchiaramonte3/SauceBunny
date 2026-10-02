import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/use-dismiss";
import type { ShotAudioState, ShotDialogueState } from "../hooks/use-shot-intelligence";
import { IconInfo } from "./Icons";
import { ShotAudioDetails } from "./ShotAudioDetails";

/** Run context stays with its analysis owner; only this disclosure leaves the drawer. */
export function ShotAnalysisInfo({ source, model, fps, status, failure, audio, audioError, dialogue }: {
  source: string | null; model?: string; fps: number; status: string;
  failure: string; audio: ShotAudioState; audioError: string;
  dialogue?: ShotDialogueState;
}) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const id = useId(), issue = !!(failure || audioError || dialogue?.error);
  const close = useCallback(() => {
    if (panel.current?.contains(document.activeElement)) trigger.current?.focus();
    setOpen(false);
  }, []);
  useDismiss(panel, close, open);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), bounds = panel.current?.getBoundingClientRect();
      if (anchor && bounds) setPosition({ left: Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8)) });
    };
    place(); closeButton.current?.focus();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  const audioStatus = audio.status === "ready" ? (audio.evidence.status === "no-audio" ? "No audio track" : "Analyzed")
    : audio.status === "analyzing" ? "Analyzing" : audio.status === "stopped" ? "Stopped"
    : audio.status === "unavailable" ? "Unavailable" : "Not analyzed";
  const decoder = failure.match(/Codec: ([^.]+)\. Stage: ([^.]+)\./);
  return <>
    <button ref={trigger} type="button" className={`btn btn-ghost cp-ai-info-button${issue ? " has-issue" : ""}`}
      aria-label="Analysis info" aria-description={issue ? "Analysis incomplete" : undefined} title={issue ? "Analysis info: attention needed" : "Analysis info"}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseDown={event => event.stopPropagation()} onClick={() => setOpen(value => !value)}>
      <IconInfo size={16} />
      {issue && <span className="cp-ai-info-dot" aria-hidden="true" />}
    </button>
    {open && createPortal(<div ref={panel} id={id} className="cp-shot-info" role="dialog" aria-label="Analysis info" style={position}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="cp-shot-info-heading"><strong>Analysis info</strong><button ref={closeButton} type="button" className="cp-icon-btn" aria-label="Close analysis info" onClick={close}>×</button></div>
      <dl>
        <dt>Status</dt><dd>{status}</dd>
        <dt>Source</dt><dd title={source ?? undefined}>{source?.split(/[\\/]/).pop() ?? "Not selected"}</dd>
        <dt>Model used</dt><dd>{model ?? "Not run"}</dd>
        <dt>Audio</dt><dd>{audioStatus}</dd>
        {dialogue && <><dt>Dialogue</dt><dd>{dialogue.status === "ready" ? "Available" : dialogue.status === "analyzing" ? "Transcribing and detecting speakers" : dialogue.status === "unavailable" ? "Unavailable" : dialogue.status === "stopped" ? "Stopped" : "Not generated"}</dd></>}
        <dt>Timecode</dt><dd>{Number(fps.toFixed(3))} fps, non-drop-frame. End is exclusive.</dd>
        <dt>Processing</dt><dd>On this Mac</dd>
      </dl>
      <p>Cut markers sit below the timeline. Chapters stay above.</p>
      {audio.status === "ready" && <ShotAudioDetails evidence={audio.evidence} fps={fps} />}
      {(failure || audioError || dialogue?.error) && <div className="cp-shot-info-diagnostics">
        <p>{decoder ? `Codec: ${decoder[1]}. Stage: ${decoder[2]}. Update the runtime or try a compatible local copy.` : "Review the details, then retry when ready."}</p>
        <details><summary>Technical details</summary>{failure && <p>{failure}</p>}{audioError && audioError !== failure && <p>{audioError}</p>}{dialogue?.error && <p>{dialogue.error}</p>}</details>
      </div>}
    </div>, document.body)}
  </>;
}
