import type { AafDocument } from "../bindings/AafDocument";
import type { MultitrackRunReport } from "../hooks/use-multitrack-transcription";
import { sequenceTimecode, trackOwner } from "../lib/multitrack";

/** Quiet summary, explicit failures, and recoverable technical details. */
export function MultitrackRunInfo({ document, report, error, loading }: {
  document: AafDocument; report?: MultitrackRunReport | null; error?: string | null; loading?: boolean;
}) {
  const reviewCount = document.transcripts.reduce((count, track) => count + (track.timing_issues?.length ?? 0), 0);
  const notes = [...new Set(document.transcripts.flatMap((track) => track.warnings))];
  return <div className="cp-multitrack-run-info">
    {loading ? <p role="status">Generating… Each finished track appears here and is saved locally.</p>
      : report ? <p role="status">{report.stopped ? "Stopped · " : ""}{report.saved} of {report.requested} tracks saved{report.failures.length ? ` · ${report.failures.length} failed` : ""}{report.empty ? ` · ${report.empty} with no speech` : ""}. {report.saved ? "Choose a person above to read their results." : "No new results were saved."}</p> : null}
    {reviewCount > 0 && <p role="status">Timing review: {reviewCount} {reviewCount === 1 ? "passage" : "passages"}. The text is preserved without a timeline position. Choose All voices to review everything.</p>}
    {error && <p role="status">Transcription needs attention. Open Get Info for details.</p>}
    <details><summary>Get Info</summary>
      <p>Results are saved with this sequence in Multitrack → Saved sequences. They are not automatically added as separate files in Transcripts. Export below to choose a CSV or text file location.</p>
      {!!report?.failures.length && <><p>These tracks were not saved. Check them and generate again to retry. Existing results are unchanged.</p><ul>{report.failures.map((failure) => <li key={failure.trackId}><strong>{trackOwner(document, failure.trackId)}</strong>: {failure.message}</li>)}</ul></>}
      {error && <p>{error}</p>}
      {document.transcripts.map((result) => <p key={result.track_id}><strong>{trackOwner(document, result.track_id)}</strong> · {result.status === "empty" ? "No speech found" : result.status === "review" ? "Saved; timing review needed" : "Saved"} · {result.engine} · {result.model_id}<br />{sequenceTimecode(document.manifest, result.start_frame)} to {sequenceTimecode(document.manifest, result.start_frame + result.duration_frames)}</p>)}
      {reviewCount > 0 && <p>The engine supplied an empty, reversed, or out-of-range timestamp. That does not mean the source audio is damaged. Those passages are kept separately so they cannot jump the playhead to an invalid time.</p>}
      {notes.map((note) => <p key={note}>{note}</p>)}
    </details>
  </div>;
}
