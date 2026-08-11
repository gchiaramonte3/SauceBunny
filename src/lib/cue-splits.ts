import type { Cue } from "./srt";

/**
 * Cutting a Whisper cue into smaller cues, so a phrase can be addressed.
 *
 * THE PROBLEM THIS EXISTS FOR. whisper-cli runs with `-ml 84`, which breaks
 * lines on a character budget and not on meaning, so a single cue routinely
 * carries the end of one person's sentence and the start of another's. The
 * per-cue speaker layer (`cueTag`) can only reassign a WHOLE cue, and
 * `selectionToCueRange` snaps a lasso outward to whole cues for the same
 * reason. The result the user sees is that the last four words of a cue cannot
 * be given to the person who actually said them — the smallest thing the app
 * can talk about is bigger than the thing they want to fix.
 *
 * THE TIMECODE IS INTERPOLATED, AND THAT IS THE WHOLE COST. There are no
 * word-level timings to split on: `stripCaptionMarkup` drops them at parse and
 * Whisper's SRT never carried them. So a fragment's start is derived from where
 * the cut falls in the TEXT, proportionally across the cue's own duration.
 *
 * That estimate is defensible here and it is worth being precise about why.
 * Speech rate inside one 84-character cue is near enough constant — a cue is
 * two to five seconds of one person mid-sentence, not a scene — so the error is
 * a fraction of a second, bounded by the cue's own length. And the error is
 * spent on the right thing: attributing a phrase to a speaker, where being 200ms
 * early on the boundary changes nothing a reader would notice. It would NOT be
 * good enough to cut media on, which is why splitting produces cues and never
 * touches the clip's mark points.
 *
 * OFFSETS ARE STORED AS CHARACTER POSITIONS, NEVER AS TIMES. Re-detect speakers
 * re-emits every cue with its text and start unchanged, so a character offset
 * still points at the same words afterwards. A stored time would survive too,
 * but only by coincidence, and it would carry the interpolation error into
 * storage where it compounds each time the cue is re-split. The text is what
 * the user pointed at; the text is what gets remembered.
 *
 * PIPELINE ORDER: `parseSrt → applySplits → retagCues → groupIntoTurns`.
 * Splitting FIRST is what makes the fragment addressable: it becomes a real cue
 * with its own start, so `cueTag` can key on it by millisecond exactly like any
 * other cue, and `groupIntoTurns` re-derives the turn boundary for free. No
 * consumer below this line needs to know a split happened.
 */

/** Cue start in whole milliseconds → character offsets to cut its text at. */
export type CueSplits = Record<string, number[]>;

/**
 * The shortest fragment worth minting, in milliseconds.
 *
 * Below roughly one frame the fragment is not separately seekable, and two
 * fragments whose starts round to the same millisecond would collide on the
 * `cueTag` key and be reassigned together — silently making the split a lie.
 */
const MIN_FRAGMENT_MS = 40;

/** The `splits` key for a cue: its start in whole ms, same basis as `cueKey`. */
export function splitKey(startSeconds: number): string {
  return String(Math.round(startSeconds * 1000));
}

/**
 * Move an offset to the nearest word boundary.
 *
 * A drag ends where the pointer was, which is regularly mid-word. Cutting there
 * leaves "…the ma" / "n said…" in two different people's mouths, which reads as
 * a bug even though the speaker assignment is exactly what was asked for.
 * Snapping outward to whitespace keeps both fragments readable, and it matches
 * what `selectionToCueRange` already does one level up: widen to the nearest
 * boundary the user can see, rather than honour a pixel.
 *
 * Ties go LEFT, so a cut in the middle of a word keeps that whole word with the
 * fragment the user was dragging toward.
 */
export function snapToWord(text: string, offset: number): number {
  const n = text.length;
  const at = Math.max(0, Math.min(n, Math.round(offset)));
  if (at === 0 || at === n) return at;
  // Already on a boundary: whitespace on either side of the cut.
  if (/\s/.test(text[at - 1]) || /\s/.test(text[at])) return at;
  let left = at;
  while (left > 0 && !/\s/.test(text[left - 1])) left -= 1;
  let right = at;
  while (right < n && !/\s/.test(text[right])) right += 1;
  return at - left <= right - at ? left : right;
}

/**
 * Clean a set of requested cuts into ones that can actually be applied.
 *
 * Snapped to words, sorted, and stripped of the cuts that would produce an
 * empty fragment: offset 0 or the end of the text, and any two cuts with only
 * whitespace between them. That last case is not hypothetical — the two sides
 * of a single space are different offsets that both snap to themselves, so
 * cutting after "bbb" and later selecting from the start of "ccc" yields 7 and
 * 8 for the same gap. Kept as two cuts they mint a fragment holding one space,
 * which trims to nothing and leaves a hole in the timeline where a cue used to
 * be. Doing this at the edge means everything downstream — the render, the
 * persisted document, the millisecond keys — only ever sees offsets that
 * describe a real division of the text.
 */
export function normalizeSplitOffsets(text: string, offsets: readonly number[]): number[] {
  const out: number[] = [];
  for (const raw of offsets) {
    if (!Number.isFinite(raw)) continue;
    const at = snapToWord(text, raw);
    // A cut at either end divides nothing.
    if (at <= 0 || at >= text.length) continue;
    // Also catches an exact repeat, where the span is empty.
    const sameGap = out.some(
      (k) => text.slice(Math.min(k, at), Math.max(k, at)).trim() === "",
    );
    if (!sameGap) out.push(at);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Cut one cue into fragments. Returns `[cue]` when there is nothing to cut.
 *
 * Each fragment keeps the parent's `index` — it records which source cue these
 * words came from, which is true and occasionally useful, and nothing keys on
 * it for uniqueness (`serializeCues` renumbers on write).
 *
 * The speaker is carried unchanged. Splitting is a division of text, not a
 * reassignment; the caller reassigns a fragment afterwards through `cueTag`,
 * and keeping the two steps separate is what lets a split be undone without
 * touching who said what.
 */
export function splitCue(cue: Cue, offsets: readonly number[]): Cue[] {
  return splitCueParts(cue, offsets).map((p) => p.cue);
}

/**
 * The same cut, with each fragment's character span attached.
 *
 * The caller that made the cut needs to know WHICH fragment the phrase became,
 * so it can reassign it — and it must not re-derive that from the offsets it
 * passed in, because some of those are dropped here (a cut too close to its
 * neighbour to be a distinct cue). Deriving the answer twice, once with the
 * filtering and once without, is how the reassignment lands on the wrong
 * fragment for exactly the short cues where it is hardest to notice.
 *
 * Spans are into the ORIGINAL, untrimmed text, so a lookup by the offset the
 * user selected at is exact.
 */
export function splitCueParts(
  cue: Cue, offsets: readonly number[],
): { cue: Cue; from: number; to: number }[] {
  const whole = [{ cue, from: 0, to: cue.text.length }];
  const cuts = normalizeSplitOffsets(cue.text, offsets);
  if (cuts.length === 0) return whole;

  const span = cue.end - cue.start;
  const chars = cue.text.length;
  // A cue with no duration cannot be divided in time, whatever its text says.
  if (!(span > 0) || chars === 0) return whole;

  // Interpolate each cut, then keep only the ones that still advance the clock
  // enough to be a distinct, seekable fragment. Checked against the PREVIOUS
  // kept boundary so a run of near-identical cuts collapses to one.
  const bounds: { at: number; time: number }[] = [];
  let prevTime = cue.start;
  for (const at of cuts) {
    const time = cue.start + (span * at) / chars;
    if ((time - prevTime) * 1000 < MIN_FRAGMENT_MS) continue;
    // The tail must also survive, or the last fragment is the degenerate one.
    if ((cue.end - time) * 1000 < MIN_FRAGMENT_MS) continue;
    bounds.push({ at, time });
    prevTime = time;
  }
  if (bounds.length === 0) return whole;

  const out: { cue: Cue; from: number; to: number }[] = [];
  let fromChar = 0;
  let fromTime = cue.start;
  const push = (toChar: number, toTime: number) => {
    const slice = cue.text.slice(fromChar, toChar);
    // `from` is the offset of the fragment's first VISIBLE character, not of
    // the slice. A cut can land on either side of its space, so a slice may
    // begin with one, and the text that gets rendered is trimmed. Reporting
    // the untrimmed offset would put every mapping from a selection inside
    // this fragment back into parent coordinates off by one — invisible in
    // the common case and a one-character mis-cut in the rest.
    const lead = slice.length - slice.trimStart().length;
    out.push({
      cue: { ...cue, start: fromTime, end: toTime, text: slice.trim() },
      from: fromChar + lead,
      to: toChar,
    });
    fromChar = toChar;
    fromTime = toTime;
  };
  for (const b of bounds) push(b.at, b.time);
  push(chars, cue.end);
  // A fragment that trimmed to nothing would render as a nameless empty line
  // and, worse, be a seekable cue with no words in it.
  return out.filter((p) => p.cue.text.length > 0);
}

/**
 * The fragment a character offset falls in, after a cut. Null when the offset
 * lands in a fragment that was dropped for being empty.
 */
export function fragmentAt(cue: Cue, offsets: readonly number[], charOffset: number): Cue | null {
  const parts = splitCueParts(cue, offsets);
  const hit = parts.find((p) => charOffset >= p.from && charOffset < p.to);
  return hit ? hit.cue : null;
}

/**
 * Apply every stored split to a cue list.
 *
 * Returns the input array unchanged when nothing applies, so the caption
 * overlay and the transcript render can both call it unconditionally on every
 * frame without paying for a copy — the same contract `retagCues` keeps, and
 * for the same reason.
 */
export function applySplits(cues: Cue[], splits: CueSplits | undefined): Cue[] {
  if (!splits || Object.keys(splits).length === 0) return cues;
  let touched = false;
  const out: Cue[] = [];
  for (const c of cues) {
    const offsets = splits[splitKey(c.start)];
    if (!offsets || offsets.length === 0) { out.push(c); continue; }
    const parts = splitCue(c, offsets);
    if (parts.length > 1) touched = true;
    out.push(...parts);
  }
  return touched ? out : cues;
}

/**
 * For every cue `applySplits` produces, the parse-time cue it came from and
 * the character offset where it begins in that cue's text.
 *
 * WHY AN EDITOR CANNOT WORK WITHOUT THIS. After a split, the cue the user is
 * looking at is a FRAGMENT: its start is interpolated, so it is not the key its
 * own cuts are stored under, and a selection inside it yields offsets into its
 * own text rather than the parent's. Cutting a second phrase out of an already
 * divided line therefore writes a `splits` entry under a key that matches no
 * parsed cue — inert, silent, and indistinguishable from the feature being
 * broken. Mapping back to the parent first is what makes the second cut behave
 * like the first.
 *
 * INDEX-ALIGNED WITH `applySplits`, deliberately: entry `i` describes output
 * cue `i`. `retagCues` and `groupIntoTurns` both preserve order and count, so a
 * viewer's flattened cue index addresses this array directly. The alignment is
 * a contract, and it is asserted in the tests.
 */
export function splitOrigins(
  cues: readonly Cue[], splits: CueSplits | undefined,
): { parent: Cue; from: number }[] {
  const out: { parent: Cue; from: number }[] = [];
  for (const c of cues) {
    const offsets = splits?.[splitKey(c.start)];
    if (!offsets || offsets.length === 0) { out.push({ parent: c, from: 0 }); continue; }
    for (const p of splitCueParts(c, offsets)) out.push({ parent: c, from: p.from });
  }
  return out;
}

/**
 * Where a character range inside a cue's text wants to be cut.
 *
 * A user selecting a phrase implies up to TWO cuts, one at each end, and the
 * ends that coincide with the cue's own edges imply nothing. Returned already
 * merged with whatever cuts that cue is carrying, because a second split in the
 * same cue must add to the first rather than replace it — otherwise extracting
 * two phrases from one long cue would be impossible, which is the exact case
 * this feature exists for.
 */
export function splitsForRange(
  text: string,
  existing: readonly number[] | undefined,
  from: number,
  to: number,
): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return normalizeSplitOffsets(text, [...(existing ?? []), lo, hi]);
}

/**
 * Drop every cut a cue is carrying.
 *
 * The undo for a split, and deliberately whole-cue: a user who wants the
 * original sentence back wants the sentence, not one of three boundaries. Any
 * `cueTag` written against a fragment's start is left in place and simply stops
 * matching a cue — inert, not wrong, and it comes back if the same split is
 * made again.
 */
export function clearSplits(splits: CueSplits, startSeconds: number): CueSplits {
  const key = splitKey(startSeconds);
  if (!(key in splits)) return splits;
  const next = { ...splits };
  delete next[key];
  return next;
}
