import { useState } from "react";
import type { MultitrackLibraryEntry } from "../lib/transcript-library";
import { IconMultitrack } from "./IconMultitrack";

export function matchingMultitrackEntries(entries: MultitrackLibraryEntry[], query: string) {
  return entries.filter(entry => entry.title.toLocaleLowerCase().includes(query.trim().normalize("NFC").toLocaleLowerCase()));
}
export function MultitrackLibraryRows({ entries, selected, query, onOpen }: {
  entries: MultitrackLibraryEntry[]; selected: string | null; query: string; onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const shown = matchingMultitrackEntries(entries, query);
  if (!shown.length) return null;
  return <section className="cp-reader-group" aria-label="AAF Audio transcripts">
    <button className="btn btn-ghost cp-multitrack-library-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <IconMultitrack size={16} />AAF Audio <span>{shown.length}</span>
    </button>
    {expanded && shown.map(entry => <button key={entry.id} type="button" className={`cp-reader-row${selected === entry.id ? " active" : ""}`} aria-current={selected === entry.id ? "true" : undefined} onClick={() => onOpen(entry.id)} title={entry.summary.source_path}>
      <IconMultitrack size={20} /><span className="cp-reader-row-body"><span className="cp-reader-row-title">{entry.title}</span>
        <span className="cp-reader-row-meta">{entry.summary.transcribed_tracks} / {entry.summary.track_count} tracks · Saved locally</span></span>
    </button>)}
  </section>;
}
