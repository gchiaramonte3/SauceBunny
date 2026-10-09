type Props = {
  /** Sources with mics in this string out. */
  sources: string[];
};

/**
 * Over the lanes of a string out with nothing cut in. A record is built from
 * the source, as an Avid sequence is: there is no adding a whole sequence to
 * it, because a record holding every track of the group read as anything but
 * a record.
 */
export function EditTimelineEmpty({ sources }: Props) {
  return <div className="cp-te-tl-empty">
    <div className="cp-te-tl-empty-card"><p>{sources.length
      ? "Nothing is cut in yet. Mark In and Out in the source, turn on the tracks you want, and press Insert (V) or Overwrite (B)."
      : "Nothing to cut from yet. Choose a sequence from Add sequence, above."}</p></div>
  </div>;
}
