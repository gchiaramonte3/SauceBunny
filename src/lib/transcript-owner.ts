/**
 * Which source a transcript belongs to, and who is allowed to render it.
 *
 * THE BUG THIS EXISTS FOR. `activeTranscript` is one piece of App state read by
 * two different pages: the reader (its whole subject) and the Clip (its
 * Transcript tab, its on-video captions, its timeline speaker lanes). Opening a
 * transcript in the reader wrote that state and navigated away — but the Clip
 * kept whatever video it already had, so switching back showed one film's
 * dialogue burned over another film's picture, with the AI summary and the
 * speaker lanes agreeing with the caption rather than the footage.
 *
 * It is the worst shape a bug can take in a review tool: everything renders,
 * nothing errors, and the result is confidently wrong about who said what.
 *
 * THE RULE: a transcript names the source it was made for, and the Clip shows
 * it only when that is the source the Clip is playing. The reader is
 * deliberately NOT gated — a reader opened on a transcript is showing that
 * transcript on purpose, and may have no player at all.
 */

/** What a source is keyed by: a local path, or the URL for a web source. */
export type SourceKey = string | null;

export type ActiveTranscript = {
  path: string;
  origin: "captions" | "whisper" | "unknown";
  /**
   * The source this transcript describes.
   *
   * `null` means "unknown", which is treated as belonging to whoever asks. That
   * is deliberate: transcripts predating this field, and history entries with
   * no linked source, would otherwise silently vanish from a Clip that had been
   * showing them quite correctly. An unknown owner is a weaker claim than a
   * wrong one.
   */
  sourceKey: SourceKey;
};

/**
 * May the Clip render this transcript over the source it is currently playing?
 *
 * Compares by exact key. No normalisation, and none wanted: both sides come
 * from the same App state that opened the file, so a mismatch here is a real
 * difference of subject rather than a formatting difference of path.
 */
export function transcriptBelongsToSource(
  active: ActiveTranscript | null,
  current: SourceKey,
): boolean {
  if (!active) return false;
  // Unknown owner: trust the caller (see the field's note).
  if (active.sourceKey == null) return true;
  // A Clip with nothing loaded owns nothing, so an owned transcript is not its.
  if (current == null) return false;
  return active.sourceKey === current;
}

/**
 * The transcript path the CLIP may use, or null when the active transcript
 * belongs to something else.
 *
 * One function rather than the check inlined at each consumer: the captions,
 * the transcript panel, the AI summary and the speaker lanes must agree about
 * this, and four copies of a comparison is how three of them stay right.
 */
export function clipTranscriptPath(
  active: ActiveTranscript | null,
  current: SourceKey,
): string | null {
  return transcriptBelongsToSource(active, current) ? (active?.path ?? null) : null;
}
