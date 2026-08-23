import { loadJson, saveJson } from "./storage";
import { pathKey } from "./repath";

/**
 * In and out marks, remembered per source.
 *
 * Marks were the only hand-made thing in the workspace that did not survive.
 * `resetForNewSource` nulls them on every source switch and nothing wrote them
 * anywhere, so they died on quit too — while chosen poster frames, source
 * start timecodes, chapters, review docs and the entire clip queue all persist,
 * keyed the same way. The queue's own test file says why it bothers: each row
 * "is a range somebody marked by hand, so it is the one thing in the workspace
 * that cannot be recreated by pressing a button again". A mark is that same
 * thing before it reaches the queue.
 *
 * Keyed like `sourceTimecodes`: a local path (NFC-normalised, so a rename that
 * changes only Unicode form still finds it) or a webpage URL.
 *
 * FRAMES, not seconds, because that is what the transport stores and what an
 * export uses — converting on the way in and out would round twice and could
 * move a mark by a frame across a save/load cycle.
 */

const KEY = "saucebunny.sourceMarks";

export type SourceMarks = { inFrames: number | null; outFrames: number | null };

/** A frame index that could plausibly have come from this app. */
function validFrame(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

export function loadSourceMarks(): Record<string, SourceMarks> {
  const raw = loadJson<unknown>(KEY, {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, SourceMarks> = {};
  for (const [rawKey, v] of Object.entries(raw)) {
    const k = pathKey(rawKey);
    if (!k || typeof v !== "object" || v === null) continue;
    const rec = v as Partial<SourceMarks>;
    const i = validFrame(rec.inFrames) ? rec.inFrames : null;
    const o = validFrame(rec.outFrames) ? rec.outFrames : null;
    // A pair where out is not after in is not a range anyone marked; dropping
    // it here means a corrupt or hand-edited file cannot restore something the
    // export would then refuse.
    if (i === null && o === null) continue;
    if (i !== null && o !== null && o <= i) continue;
    out[k] = { inFrames: i, outFrames: o };
  }
  return out;
}

/** The marks for one source, or nulls when it has none. */
export function marksFor(source: string | null | undefined): SourceMarks {
  if (!source) return { inFrames: null, outFrames: null };
  const map = loadSourceMarks();
  return map[pathKey(source)] ?? { inFrames: null, outFrames: null };
}

/**
 * Remember this source's marks. Clearing both forgets the entry rather than
 * storing a pair of nulls, so the map does not grow a row for every source
 * whose marks were merely cleared.
 */
export function setSourceMarks(
  source: string | null | undefined,
  marks: SourceMarks,
): void {
  if (!source) return;
  const map = loadSourceMarks();
  const k = pathKey(source);
  if (marks.inFrames === null && marks.outFrames === null) {
    if (!(k in map)) return;
    delete map[k];
  } else {
    map[k] = marks;
  }
  saveJson(KEY, map);
}
