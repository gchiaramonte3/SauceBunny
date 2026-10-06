import { useMemo, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { MultitrackPerson } from "../lib/multitrack-person";
import { hasTranscriptContent } from "../lib/multitrack";
import { useMultitrackExport, type MultitrackExportFormat } from "../hooks/use-multitrack-export";
import { StatefulButton } from "./StatefulButton";
import { MultitrackExportMore } from "./MultitrackExportMore";
import { hasGroupMicrophones } from "../lib/multitrack-avid-files";

export function MultitrackExport({ document, person, selectedTracks }: { document: AafDocument; person?: MultitrackPerson; selectedTracks?: ReadonlySet<string> }) {
  const [format, setFormat] = useState<MultitrackExportFormat>("txt"), output = useMultitrackExport(document);
  const selectedIds = useMemo(() => document.manifest.tracks.filter(track => selectedTracks?.has(track.id)).map(track => track.id), [document.manifest.tracks, selectedTracks]);
  const counts = useMemo(() => {
    const tracks = document.transcripts.map((track) => ({ id: track.track_id, timed: track.cues.some((cue) => hasTranscriptContent(cue.text)), untimed: track.timing_issues?.some((cue) => hasTranscriptContent(cue.text)) }));
    const scoped = tracks.filter((track) => !person || person.trackIds.includes(track.id));
    const checked = tracks.filter(track => selectedIds.includes(track.id));
    return { scoped: scoped.some((track) => track.timed || track.untimed), timed: scoped.some((track) => track.timed), any: tracks.some((track) => track.timed || track.untimed), anyTimed: tracks.some((track) => track.timed), selected: checked.some(track => track.timed || track.untimed), selectedTimed: checked.some(track => track.timed) };
  }, [document.transcripts, person, selectedIds]);
  const busy = output.phase === "loading";
  const grouped = hasGroupMicrophones(document);
  const timedOnly = format === "avid" || format === "srt";
  // One row: the format, Export for the person on screen, and the rest behind the chevron.
  return <footer className="cp-multitrack-export">
    <div className="cp-multitrack-export-current"><select className="cp-select" aria-label="Transcript export format" value={format} onChange={(event) => setFormat(event.target.value as MultitrackExportFormat)} disabled={busy}>
      <option value="txt">Plain text</option><option value="csv">CSV</option><option value="avid">Avid markers</option><option value="srt">SRT captions</option><option value="pdf">PDF</option><option value="print">Print…</option></select>
      <StatefulButton className="btn btn-primary cp-export-cta cp-sbtn-export" phase={output.phase} idleContent={person ? `Export ${person.name}` : "Export transcript"} loadingLabel="Exporting…" onClick={() => void output.download(format, person?.trackIds, person?.name)} onResolved={output.clearResolution} disabled={timedOnly ? !counts.timed : !counts.scoped} />
      <MultitrackExportMore document={document} format={format} busy={busy} grouped={grouped}
        selected={selectedTracks ? { count: selectedIds.length, ready: timedOnly ? counts.selectedTimed : counts.selected } : null}
        entire={timedOnly ? counts.anyTimed : counts.any} byPerson={counts.anyTimed}
        onSelected={() => void output.download(format, selectedIds, "Selected tracks")} onEntire={() => void output.download(format)} onByPerson={() => void output.downloadPeople()} />
    </div>
    {output.status && <p className="cp-multitrack-note" role="status">{output.status}</p>}
    {output.error && <p className="cp-multitrack-error" role="alert">{output.error}</p>}
  </footer>;
}
