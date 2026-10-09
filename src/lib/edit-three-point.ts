/**
 * Avid's three-point edit: which of the four marks (source In and Out, record
 * In and Out) decide an Insert's or an Overwrite's length, where it lands, and
 * which source range it takes. The rules are Media Composer's, as its Help
 * states them for backtimed edits:
 *
 * - The record marks always win. With both set, they are the edit's footprint
 *   and the source gives only a start: its In, or backtimed from its Out.
 * - Otherwise the source gives the length: In to Out, or with one of them, to
 *   the end (or from the start) of the source.
 * - The edit lands at the record In; with only a record Out it ends there
 *   (backtimed); with neither, at the record playhead.
 *
 * Seconds, with Outs exclusive like every range in String Outs: a range
 * marked In 4 and Out 6 is two seconds long. Two choices are String Outs'
 * own, where Avid's Help is silent and its default suits a clip but not an
 * hours-long source sequence:
 *
 * - Record In and Out with no source mark take the source from its playhead
 *   (Avid with Single-Mark Editing on), not from the start of the sequence.
 * - No source mark and not both record marks is refused rather than taking
 *   the whole source, which for a group sequence is hours of everyone.
 */

/** A side's marks, null where not set. */
export type MarkPair = { in: number | null; out: number | null };

export type ThreePointInput = {
  /** The source's marks, its playhead, and the extent of its material. */
  source: MarkPair & { playhead: number; start: number; end: number };
  /** The record's marks and its playhead. */
  record: MarkPair & { playhead: number };
};

export type ThreePoint = { srcIn: number; srcOut: number; at: number };
export type ThreePointResult = { edit: ThreePoint } | { refusal: string };

const EPSILON = 1e-6;
const both = (marks: MarkPair): marks is { in: number; out: number } => marks.in != null && marks.out != null && marks.out > marks.in;

export function resolveThreePoint({ source, record }: ThreePointInput): ThreePointResult {
  let srcIn: number, length: number, at: number;
  if (both(record)) {
    // The record marks are the footprint; the source says where it starts.
    length = record.out - record.in;
    at = record.in;
    srcIn = source.in ?? (source.out != null ? source.out - length : source.playhead);
  } else {
    if (both(source)) { srcIn = source.in; length = source.out - source.in; }
    else if (source.in != null) { srcIn = source.in; length = source.end - source.in; }
    else if (source.out != null) { srcIn = source.start; length = source.out - source.start; }
    else return { refusal: "Nothing is marked in the source. Mark an In or an Out there, select words, or mark both an In and an Out in the record." };
    at = record.in ?? (record.out != null ? record.out - length : record.playhead);
    if (at < -EPSILON) return { refusal: "The clip is longer than the record before its Out mark. Mark a shorter source range or a later record Out." };
  }
  if (length <= EPSILON) return { refusal: "The marked source range is empty. Mark an Out after the In." };
  if (srcIn < source.start - EPSILON) return { refusal: "There is not enough source before the source Out to fill the record marks. Mark a later source Out or a shorter record range." };
  if (srcIn + length > source.end + EPSILON) return { refusal: "There is not enough source after the source In to fill the record marks. Mark an earlier source In or a shorter record range." };
  return { edit: { srcIn, srcOut: srcIn + length, at: Math.max(0, at) } };
}
