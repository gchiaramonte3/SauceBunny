import { documentKey, type MultitrackLibraryEntry } from "../lib/transcript-library";
import { IconMultitrack } from "./IconMultitrack";
import type { DocumentMenuTarget } from "./MultitrackRowMenu";

export function matchingMultitrackEntries(entries: MultitrackLibraryEntry[], query: string) {
  return entries.filter(entry => entry.title.toLocaleLowerCase().includes(query.trim().normalize("NFC").toLocaleLowerCase()));
}

/**
 * AAF Audio transcripts as rows of the Transcripts list, in their own group or
 * in the project they are filed in. A row carries its document's key where a
 * transcript carries its path, so it drags onto a project heading like a
 * transcript does; right-click opens what can be done with it.
 */
export function MultitrackLibraryRows({ entries, selected, onOpen, onMenu }: {
  entries: MultitrackLibraryEntry[]; selected: string | null; onOpen: (id: string) => void; onMenu: (target: DocumentMenuTarget) => void;
}) {
  return <>{entries.map(entry => <button key={entry.id} type="button" className={`cp-reader-row${selected === entry.id ? " active" : ""}`}
    data-path={documentKey(entry.id)} aria-current={selected === entry.id ? "true" : undefined} onClick={() => onOpen(entry.id)}
    onContextMenu={(event) => { event.preventDefault(); event.currentTarget.focus(); onMenu({ entry, x: event.clientX, y: event.clientY }); }}
    title={entry.title === entry.summary.name ? entry.summary.source_path : `${entry.summary.name} · ${entry.summary.source_path}`}>
    <span className="cp-reader-row-thumb" aria-hidden="true"><IconMultitrack size={16} /></span><span className="cp-reader-row-body"><span className="cp-reader-row-title">{entry.title}</span>
      <span className="cp-reader-row-meta">{entry.summary.transcribed_tracks} / {entry.summary.track_count} tracks · AAF Audio</span></span>
  </button>)}</>;
}
