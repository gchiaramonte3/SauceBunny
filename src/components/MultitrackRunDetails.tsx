import { useRef } from "react";
import { createPortal } from "react-dom";
import type { AafDocument } from "../bindings/AafDocument";
import type { MultitrackRunReport } from "../hooks/use-multitrack-transcription";
import { useDismiss } from "../hooks/use-dismiss";
import { useModalFocus } from "../hooks/use-modal-focus";
import { sequenceTimecode, trackOwner } from "../lib/multitrack";

/** Where results are saved, what failed, and each track's engine and range: opened from the info button. */
export function MultitrackRunDetails({ document, report, error, onClose }: {
  document: AafDocument; report?: MultitrackRunReport | null; error?: string | null; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialog);
  useDismiss(dialog, onClose);
  const reviewCount = document.transcripts.reduce((count, track) => count + (track.timing_issues?.length ?? 0), 0);
  const notes = [...new Set(document.transcripts.flatMap((track) => track.warnings))];
  return createPortal(<div className="cp-modal-scrim">
    <div ref={dialog} className="cp-multitrack-settings cp-multitrack-run-details" role="dialog" aria-modal="true" aria-label="Transcript info" tabIndex={-1}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header><h2>Transcript info</h2><button className="btn btn-ghost" aria-label="Close transcript info" onClick={onClose}>×</button></header>
      <p>Results are saved with this sequence in AAF Audio → Saved sequences. They are not automatically added as separate files in Transcripts. Use Export to choose a CSV or text file location.</p>
      {!!report?.failures.length && <section><h3>Not saved</h3><p>Check these tracks and generate again to retry. Existing results are unchanged.</p>
        <ul>{report.failures.map((failure) => <li key={failure.trackId}><strong>{trackOwner(document, failure.trackId)}</strong>: {failure.message}</li>)}</ul></section>}
      {error && <section><h3>Needs attention</h3><p>{error}</p></section>}
      {document.transcripts.length > 0 && <section><h3>Saved tracks</h3><ul className="cp-multitrack-run-tracks">
        {document.transcripts.map((result) => <li key={result.track_id}><strong>{trackOwner(document, result.track_id)}</strong>
          <span>{result.status === "empty" ? "No speech found" : result.status === "review" ? "Saved; timing review needed" : "Saved"} · {result.engine} · {result.model_id}</span>
          <span>{sequenceTimecode(document.manifest, result.start_frame)} to {sequenceTimecode(document.manifest, result.start_frame + result.duration_frames)}</span>
          {result.gaps?.map(([from, to]) => <span key={from}>Not transcribed: {sequenceTimecode(document.manifest, from)} to {sequenceTimecode(document.manifest, to)}</span>)}</li>)}
      </ul></section>}
      {reviewCount > 0 && <p>The engine supplied an empty, reversed, or out-of-range timestamp. That does not mean the source audio is damaged. Those passages are kept separately so they cannot jump the playhead to an invalid time.</p>}
      {notes.length > 0 && <section><h3>Notes</h3>{notes.map((note) => <p key={note}>{note}</p>)}</section>}
      <footer><button className="btn" onClick={onClose}>Done</button></footer>
    </div>
  </div>, globalThis.document.body);
}
