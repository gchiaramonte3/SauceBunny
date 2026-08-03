/**
 * Producer notes → review comments: the paste side of the review panel.
 *
 * THE INPUT IS HOSTILE BY NATURE. Notes arrive pasted out of a Google Doc or
 * a Sheets column, typed fast by a producer watching a cut: timecodes in three
 * formats on one page, ranges with the spaces missing ("00:21 -00:43"), two
 * spots joined with an ampersand, typos ("00::08:10"), lines that open with
 * prose and bury the timecode mid-sentence, and lines with no timecode at all
 * ("At the end were we adding any of the bites?"). A parser that insisted on
 * one grammar would reject half of a real notes doc, and the half it rejected
 * would be silently lost from the review. So this parser's contract is the
 * opposite: EVERY non-empty line becomes a row, the body is always carried
 * verbatim, and the timecode is extracted when one can be found rather than
 * demanded. What cannot be anchored becomes a general note instead of
 * disappearing.
 *
 * PURE ON PURPOSE, like rename-pattern: no store, no IO. The import UI shows
 * exactly what this returns as a preview the user confirms, so every decision
 * here is visible before anything is written into the review doc.
 */

export type ParsedNote = {
  /** The line as pasted, untouched. What the preview's tooltip shows. */
  raw: string;
  /** The note text that becomes the comment body. */
  body: string;
  /** Anchor in seconds, or null for a general (untimed) note. */
  startSec: number | null;
  /** Range end in seconds, when the line carried one. */
  endSec: number | null;
  /**
   * True for lines that look like sheet furniture rather than notes — a
   * column header ("STORY NOTES"), a title row ("LMH REUNION - CUTS"). They
   * are RETURNED rather than dropped, default-unchecked in the preview, so a
   * wrong guess costs one click instead of one lost note.
   */
  suspectHeader: boolean;
};

export type ParseOptions = {
  /**
   * Duration of the cut, when known. Disambiguates "00:08:10": read as
   * h:mm:ss it is 490s, which cannot be a spot in a three-minute cut, so a
   * value past the duration is re-read as mm:ss:ff. Without a duration the
   * h:mm:ss reading stands — the general default, and the preview shows the
   * interpretation either way.
   */
  durationSec?: number;
  /** For the frames part of mm:ss:ff / hh:mm:ss:ff. Editorial default. */
  fps?: number;
};

/**
 * One timecode, tolerantly. `:{1,2}` is the typo allowance: "00::08:10" is
 * pasted reality, and rejecting the whole line over a doubled colon would
 * lose the note. 2–4 parts: m:ss, h:mm:ss (or mm:ss:ff, see above), and
 * hh:mm:ss:ff.
 */
const TOKEN = /\d{1,3}(?::{1,2}\d{1,2}){1,3}/g;

/** What may sit between two timecodes for them to read as one range. `&` is
 *  included because "00:08 & 00:08:10" is how producers write "this spot and
 *  that spot", and a span covering both is the anchor that serves the note. */
const RANGE_SEP = /^\s*(?:-|–|—|to|&)\s*$/i;

/** Seconds for one matched token, under the ambiguity rules above. */
function tokenSeconds(tok: string, opts: ParseOptions): number {
  const parts = tok.split(/:{1,2}/).map(Number);
  const fps = opts.fps ?? 30;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps;
  // Three parts: h:mm:ss unless that overshoots a known duration and the
  // mm:ss:ff reading does not.
  const hms = parts[0] * 3600 + parts[1] * 60 + parts[2];
  const msf = parts[0] * 60 + parts[1] + parts[2] / fps;
  const dur = opts.durationSec;
  if (dur && dur > 0 && hms > dur + 1 && msf <= dur + 1) return msf;
  return hms;
}

/** Sheet furniture: no timecode AND shaped like a header, not a sentence. */
function looksLikeHeader(line: string): boolean {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false; // headers are short; sentences are not
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return true; // "—", "v2", stray punctuation
  const caps = line.replace(/[^A-Z]/g, "");
  return caps.length / letters.length > 0.8; // "STORY NOTES", "LMH REUNION - CUTS"
}

function parseLine(raw: string, opts: ParseOptions): ParsedNote {
  const line = raw.trim();

  TOKEN.lastIndex = 0;
  const first = TOKEN.exec(line);
  if (!first) {
    return {
      raw, body: line, startSec: null, endSec: null,
      suspectHeader: looksLikeHeader(line),
    };
  }

  let startSec = tokenSeconds(first[0], opts);
  let endSec: number | null = null;
  let anchorEnd = first.index + first[0].length; // where the timecode prefix stops

  // A range only when the NEXT token follows immediately, joined by nothing
  // but a separator. "00:21 -00:43" is a range; "at 00:05 - 00:13 - sound so
  // different" ranges on the first pair and leaves the prose alone.
  const second = TOKEN.exec(line);
  if (second) {
    const between = line.slice(anchorEnd, second.index);
    if (RANGE_SEP.test(between)) {
      endSec = tokenSeconds(second[0], opts);
      anchorEnd = second.index + second[0].length;
      // A backwards range is a typo or a misread three-parter; swapping keeps
      // the span truthful instead of negative.
      if (endSec < startSec) [startSec, endSec] = [endSec, startSec];
      if (endSec === startSec) endSec = null; // "2:52 - 2:52" is a point
    }
  }

  // Strip the timecode prefix from the body ONLY when the line starts with it
  // ("00:05 - do we have…" → "do we have…"). A timecode buried mid-sentence
  // is part of the prose and the body keeps the whole line.
  let body = line;
  if (first.index <= 1) {
    body = line.slice(anchorEnd).replace(/^[\s\-–—:,.]+/, "").trim();
    // A line that is ONLY a timecode still needs words on the comment.
    if (!body) body = line;
  }

  return { raw, body, startSec, endSec, suspectHeader: false };
}

/**
 * Every non-empty line of the paste, one row each, order preserved.
 *
 * Google Sheets wraps a multi-line cell in quotes on copy; unwrapping folds
 * the cell's inner newlines into spaces so one cell stays one note instead of
 * splitting into a timed note plus an orphaned general one.
 */
export function parseProducerNotes(text: string, opts: ParseOptions = {}): ParsedNote[] {
  const lines: string[] = [];
  let pending: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (pending !== null) {
      pending += " " + rawLine;
      const q = countQuotes(pending);
      if (q % 2 === 0) { lines.push(unquote(pending)); pending = null; }
      continue;
    }
    if (countQuotes(rawLine) % 2 === 1) { pending = rawLine; continue; }
    lines.push(unquote(rawLine));
  }
  if (pending !== null) lines.push(unquote(pending)); // unbalanced quote at EOF

  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => parseLine(l, opts));
}

function countQuotes(s: string): number {
  return (s.match(/"/g) ?? []).length;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}
