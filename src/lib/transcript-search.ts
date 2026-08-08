import type { Cue } from "./srt";

/**
 * Search across every transcript in the library.
 *
 * THE PROBLEM THAT DEFINES THE DESIGN. Whisper is run with `-ml 84`, so it
 * breaks cues at eighty-four characters — mid-sentence, and very often
 * mid-phrase. Matching a query against each cue in turn therefore MISSES any
 * phrase that happens to straddle a break, and the user does not see a bug:
 * they see "not found" and conclude the line is not in the footage. A search
 * that silently loses results is worse than no search, because it is trusted.
 *
 * So the unit of matching is the whole transcript as ONE string, with a side
 * table mapping character offsets back to cues. A match is found in the joined
 * text and then resolved to the cue (or the FIRST of the cues) it lands in, so
 * a phrase spanning a break is found once, at the point it starts, and seeking
 * there plays the whole thing.
 *
 * NORMALISED, because transcripts are full of typography a person will not
 * type: curly apostrophes from the model, double spaces around a cue join,
 * casing. The offset table is built over the NORMALISED text so the mapping
 * stays exact — normalising after the fact would shift every offset.
 *
 * NOT PERSISTED. The index is built from the files each session and held in
 * memory. Every persisted index has the same hard problem — knowing when it
 * went stale — and a re-run transcript overwriting its own .srt is the normal
 * case here, not the exception. Reading the files is fast enough for the size
 * of library this app produces, and correctness beats a cache nobody can
 * invalidate. Revisit only with a measurement that says to.
 */

/** One transcript, ready to search. */
export type IndexedTranscript = {
  path: string;
  title: string;
  cues: readonly Cue[];
  /** All cue text joined and normalised. */
  text: string;
  /** `starts[i]` is where cue i begins in `text`. Ascending. */
  starts: readonly number[];
};

export type SearchHit = {
  path: string;
  title: string;
  /** Index into the transcript's cues — what to scroll to. */
  cueIndex: number;
  /** Seconds, for seeking the source. */
  start: number;
  speaker: string | null;
  /** The cue's own text, for display. */
  text: string;
  /** Where the query sits inside `text`, for highlighting. -1 when the match
   *  began in an earlier cue (a straddling phrase). */
  matchStart: number;
  matchEnd: number;
};

/**
 * Fold the typography apart from the words.
 *
 * Length-preserving BY CONSTRUCTION: every replacement is one character for
 * one character. That is what lets an offset in the normalised text address
 * the same position in the original, and it is why this cannot grow a rule
 * that deletes or inserts (stripping punctuation, collapsing runs of spaces)
 * without also carrying an offset map.
 */
export function normalizeForSearch(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "’" || ch === "ʼ" || ch === "‘") out += "'";
    else if (ch === "“" || ch === "”") out += '"';
    // Escapes, not the literal glyphs: these are CODEPOINTS being folded, not
    // prose, and naming them explicitly keeps the repo's no-em-dash copy guard
    // meaningful rather than allowlisted around.
    else if (ch === "\u2013" || ch === "\u2014" || ch === "\u2212") out += "-";
    else if (ch === " ") out += " ";
    else out += ch.toLowerCase();
  }
  return out;
}

/** Build the searchable form of one transcript. */
export function indexTranscript(
  path: string, title: string, cues: readonly Cue[],
): IndexedTranscript {
  const starts: number[] = [];
  let text = "";
  for (const c of cues) {
    starts.push(text.length);
    // A single space joins cues. It is one character, so offsets stay exact,
    // and it means a phrase broken across a cue reads as ordinary prose here —
    // which is precisely what makes it findable.
    text += (text.length ? " " : "") + normalizeForSearch(c.text);
    // The join space belongs to the PREVIOUS cue's span, so a match landing on
    // it resolves to the cue that was already open.
    if (starts.length > 1) starts[starts.length - 1] += 1;
  }
  return { path, title, cues, text, starts };
}

/** Which cue contains a character offset. Binary search over `starts`. */
export function cueAtOffset(idx: IndexedTranscript, offset: number): number {
  const { starts } = idx;
  if (starts.length === 0) return -1;
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Every hit for `query`, across every indexed transcript.
 *
 * Ordered by transcript (in the order given, which the caller sets to newest
 * first) and then by time within each. Deliberately NOT relevance-ranked:
 * these are substring matches, so a score would be invented precision, and an
 * editor looking for a line wants it in the order it was said.
 */
export function searchTranscripts(
  indexes: readonly IndexedTranscript[],
  query: string,
  limit = 200,
): SearchHit[] {
  const q = normalizeForSearch(query.trim());
  if (q.length < 2) return []; // one character matches everything; not a search
  const hits: SearchHit[] = [];

  for (const idx of indexes) {
    let from = 0;
    for (;;) {
      if (hits.length >= limit) return hits;
      const at = idx.text.indexOf(q, from);
      if (at < 0) break;
      const ci = cueAtOffset(idx, at);
      const cue = idx.cues[ci];
      if (cue) {
        const cueStart = idx.starts[ci];
        hits.push({
          path: idx.path,
          title: idx.title,
          cueIndex: ci,
          start: cue.start,
          speaker: cue.speaker ?? null,
          text: cue.text,
          matchStart: at - cueStart,
          matchEnd: at - cueStart + q.length,
        });
      }
      // Advance past this match so an overlapping repeat is not reported twice.
      from = at + q.length;
    }
  }
  return hits;
}

/** Hits grouped by transcript, for a result list that reads as sources. */
export function groupHits(hits: readonly SearchHit[]): {
  path: string; title: string; hits: SearchHit[];
}[] {
  const out: { path: string; title: string; hits: SearchHit[] }[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && last.path === h.path) last.hits.push(h);
    else out.push({ path: h.path, title: h.title, hits: [h] });
  }
  return out;
}
