import { useMemo, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { MultitrackPerson } from "../lib/multitrack-person";
import { hasTranscriptContent } from "../lib/multitrack";
import { useMultitrackExport, type MultitrackExportFormat } from "../hooks/use-multitrack-export";
import { StatefulButton } from "./StatefulButton";
import { MultitrackShootDate } from "./MultitrackShootDate";

export function MultitrackExport({ document, person }: { document: AafDocument; person?: MultitrackPerson }) {
  const [format, setFormat] = useState<MultitrackExportFormat>("txt"), output = useMultitrackExport(document);
  const counts = useMemo(() => {
    const tracks = document.transcripts.map((track) => ({ id: track.track_id, timed: track.cues.some((cue) => hasTranscriptContent(cue.text)), untimed: track.timing_issues?.some((cue) => hasTranscriptContent(cue.text)) }));
    const scoped = tracks.filter((track) => !person || person.trackIds.includes(track.id));
    return { scoped: scoped.some((track) => track.timed || track.untimed), timed: scoped.some((track) => track.timed), any: tracks.some((track) => track.timed || track.untimed), anyTimed: tracks.some((track) => track.timed) };
  }, [document.transcripts, person]);
  const busy = output.phase === "loading";
  const timedOnly = format === "avid" || format === "srt";
  return <footer className="cp-multitrack-export">
    {(format === "txt" || format === "pdf") && <MultitrackShootDate document={document} />}
    <div className="cp-multitrack-export-current"><select className="cp-select" aria-label="Transcript export format" value={format} onChange={(event) => setFormat(event.target.value as MultitrackExportFormat)} disabled={busy}>
      <option value="txt">Plain text</option><option value="csv">CSV</option><option value="avid">Avid markers</option><option value="srt">SRT captions</option><option value="pdf">PDF</option><option value="print">Print…</option></select>
      <StatefulButton className="btn btn-primary cp-export-cta cp-sbtn-export" phase={output.phase} idleContent={person ? `Export ${person.name}` : "Export transcript"} loadingLabel="Exporting…" onClick={() => void output.download(format, person?.trackIds, person?.name)} onResolved={output.clearResolution} disabled={timedOnly ? !counts.timed : !counts.scoped} />
    </div>
    <div className="cp-multitrack-export-all"><button className="btn btn-ghost" disabled={busy || (timedOnly ? !counts.anyTimed : !counts.any)} onClick={() => void output.download(format)}>Entire transcript</button><button className="btn btn-ghost" disabled={busy || !counts.anyTimed} onClick={() => void output.downloadPeople()}>Avid files by person</button></div>
    {format === "srt" && <p className="cp-multitrack-note">Sequence-relative captions, with mic-owner labels. Untimed text stays in text, CSV and PDF.</p>}
    {output.status && <p className="cp-multitrack-note" role="status">{output.status}</p>}
    {output.error && <p className="cp-multitrack-error" role="alert">{output.error}</p>}
  </footer>;
}
