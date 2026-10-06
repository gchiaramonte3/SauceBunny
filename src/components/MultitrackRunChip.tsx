import type { MultitrackRunReport } from "../hooks/use-multitrack-transcription";
import { plural } from "../lib/plural";

/**
 * The last run, as one chip under the search that opens Transcript info,
 * where the details are. It replaces two sentences ("Generating… Each
 * finished track appears here and is saved locally." and the saved summary)
 * that sat between the search and the first line of transcript.
 */
export function MultitrackRunChip({ report, error, loading, onInfo }: {
  report?: MultitrackRunReport | null; error?: string | null; loading?: boolean; onInfo: () => void;
}) {
  if (loading) return <span className="cp-multitrack-chip is-status" role="status">Generating…</span>;
  if (error) return <button type="button" className="cp-multitrack-chip is-alert" onClick={onInfo}>Needs attention</button>;
  if (!report) return null;
  const failed = report.failures.length;
  return <button type="button" className={`cp-multitrack-chip${failed ? " is-alert" : ""}`} onClick={onInfo}>
    {report.stopped ? "Stopped · " : ""}{report.saved} of {plural(report.requested, "track", "tracks")} saved{failed ? ` · ${failed} failed` : ""}{report.empty ? ` · ${report.empty} silent` : ""}</button>;
}
