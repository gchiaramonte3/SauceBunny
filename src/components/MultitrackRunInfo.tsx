import type { AafDocument } from "../bindings/AafDocument";
import type { MultitrackRunReport } from "../hooks/use-multitrack-transcription";

/** One-line run status under the search. Everything longer lives behind the info button. */
export function MultitrackRunInfo({ document, report, error, loading }: {
  document: AafDocument; report?: MultitrackRunReport | null; error?: string | null; loading?: boolean;
}) {
  const reviewCount = document.transcripts.reduce((count, track) => count + (track.timing_issues?.length ?? 0), 0);
  if (!loading && !report && !reviewCount && !error) return null;
  return <div className="cp-multitrack-run-info">
    {loading ? <p role="status">Generating… Each finished track appears here and is saved locally.</p>
      : report ? <p role="status">{report.stopped ? "Stopped · " : ""}{report.saved} of {report.requested} tracks saved{report.failures.length ? ` · ${report.failures.length} failed` : ""}{report.empty ? ` · ${report.empty} with no speech` : ""}. {report.saved ? "Choose a person above to read their results." : "No new results were saved."}</p> : null}
    {reviewCount > 0 && <p role="status">Timing review: {reviewCount} {reviewCount === 1 ? "passage" : "passages"}. The text is preserved without a timeline position. Choose All voices to review everything.</p>}
    {error && <p role="status">Transcription needs attention. Select Transcript info (i) for details.</p>}
  </div>;
}
