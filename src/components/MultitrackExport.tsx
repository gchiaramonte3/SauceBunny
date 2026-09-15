import { useMemo, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { MultitrackPerson } from "../lib/multitrack-person";
import { useMultitrackExport, type MultitrackExportFormat } from "../hooks/use-multitrack-export";
import { StatefulButton } from "./StatefulButton";

export function MultitrackExport({ document, person }: { document: AafDocument; person?: MultitrackPerson }) {
  const [format, setFormat] = useState<MultitrackExportFormat>("txt"), output = useMultitrackExport(document);
  const counts = useMemo(() => {
    const scoped = document.transcripts.filter((track) => !person || person.trackIds.includes(track.track_id));
    return { scoped: scoped.some((track) => track.cues.length || track.timing_issues?.length), timed: scoped.some((track) => track.cues.length), any: document.transcripts.some((track) => track.cues.length || track.timing_issues?.length), anyTimed: document.transcripts.some((track) => track.cues.length) };
  }, [document.transcripts, person]);
  const busy = output.phase === "loading";
  return <footer className="cp-multitrack-export">
    <div className="cp-multitrack-export-current"><select className="cp-select" aria-label="Transcript export format" value={format} onChange={(event) => setFormat(event.target.value as MultitrackExportFormat)} disabled={busy}>
      <option value="txt">Plain text</option><option value="csv">CSV</option><option value="avid">Avid markers</option></select>
      <StatefulButton className="btn btn-primary cp-export-cta cp-sbtn-export" phase={output.phase} idleContent={person ? `Export ${person.name}` : "Export transcript"} loadingLabel="Exporting…" onClick={() => void output.download(format, person?.trackIds, person?.name)} onResolved={output.clearResolution} disabled={format === "avid" ? !counts.timed : !counts.scoped} />
    </div>
    <div className="cp-multitrack-export-all"><button className="btn btn-ghost" disabled={busy || !counts.any} onClick={() => void output.download("txt")}>Entire transcript</button><button className="btn btn-ghost" disabled={busy || !counts.anyTimed} onClick={() => void output.downloadPeople()}>Avid files by person</button></div>
    {output.status && <p className="cp-multitrack-note" role="status">{output.status}</p>}
    {output.error && <p className="cp-multitrack-error" role="alert">{output.error}</p>}
  </footer>;
}
