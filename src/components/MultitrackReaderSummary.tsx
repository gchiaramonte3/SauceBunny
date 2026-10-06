import type { AafDocument } from "../bindings/AafDocument";
import { documentName, sequenceDurationTimecode } from "../lib/multitrack";
import { shootDate } from "../lib/multitrack-metadata";
import { multitrackPeople } from "../lib/multitrack-person";
import { plural } from "../lib/plural";

/**
 * What an AAF Audio transcript is, above its text in Transcripts: its name,
 * the sequence and file it came from, how much of it is transcribed, who is
 * in it, when and how long, and the two places it opens. It used to be a name
 * and "Open timeline".
 */
export function MultitrackReaderSummary({ document, onOpen, onOpenInStringOuts }: {
  document: AafDocument; onOpen?: () => void; onOpenInStringOuts?: () => void;
}) {
  const people = multitrackPeople(document);
  const file = document.source_path.split("/").pop() || document.source_path;
  return <header className="cp-multitrack-reader-head">
    <div className="cp-multitrack-reader-title">
      <h2>{documentName(document)}</h2>
      {document.title?.trim() && <span>Sequence {document.manifest.name}</span>}
    </div>
    <dl className="cp-multitrack-reader-facts">
      <div><dt>File</dt><dd title={document.source_path}>{file}</dd></div>
      <div><dt>Tracks</dt><dd>{plural(document.manifest.tracks.length, "track", "tracks")}, {document.transcripts.length} transcribed</dd></div>
      <div><dt>People</dt><dd title={people.map((person) => person.name).join(", ")}>{people.length}</dd></div>
      <div><dt>Shoot date</dt><dd>{shootDate(document)}</dd></div>
      <div><dt>Duration</dt><dd>{sequenceDurationTimecode(document.manifest)}</dd></div>
    </dl>
    <div className="cp-multitrack-reader-actions">
      {onOpen && <button type="button" className="btn btn-ghost" onClick={onOpen}>Open in AAF Audio</button>}
      {onOpenInStringOuts && <button type="button" className="btn btn-ghost" onClick={onOpenInStringOuts}>Open in String Outs</button>}
    </div>
  </header>;
}
