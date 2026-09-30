type Props = {
  /** Sources with mics in this string out. */
  sources: string[]; sourceName: (id: string) => string;
  /** Seconds, 0 until the sequence has been read. */
  durationOf: (source: string) => number;
  onAddWhole?: (source: string) => void;
};

/**
 * Over the lanes of a string out with nothing cut in. A sequence added to an
 * empty string out brings its mics as lanes and nothing on them, which read as
 * a timeline that had failed to load. "Add all of" waits for the sequence's
 * length, since until then it has nothing to add.
 */
export function EditTimelineEmpty({ sources, sourceName, durationOf, onAddWhole }: Props) {
  return <div className="cp-te-tl-empty">
    {sources.length ? <div className="cp-te-tl-empty-card">
      <p>Nothing is cut in yet. Select lines in Source and press Insert (V) or Append, or start from a whole sequence.</p>
      {onAddWhole && <div className="cp-te-tl-empty-actions">{sources.map((source) => <button key={source} type="button" className="btn btn-ghost"
        disabled={durationOf(source) <= 0} onClick={() => onAddWhole(source)}>Add all of {sourceName(source)}</button>)}</div>}
    </div> : <div className="cp-te-tl-empty-card"><p>Nothing to cut from yet. Choose a sequence in Add sequence… above.</p></div>}
  </div>;
}
