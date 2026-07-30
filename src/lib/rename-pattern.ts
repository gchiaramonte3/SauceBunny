/**
 * The bulk-rename engine: pattern to filenames, and every way it can go wrong.
 *
 * PURE ON PURPOSE. This does no file IO and touches no store. Bulk rename is
 * the one Library action that can destroy work at scale, and every failure mode
 * worth fearing is decidable from the names alone: two files landing on one
 * name, a name colliding with a file that was not in the selection, a character
 * the filesystem will not take. Deciding all of that before anything is written
 * is what makes an all-or-nothing apply possible, and it is what lets the
 * preview table be trustworthy rather than optimistic.
 *
 * CASE-INSENSITIVITY IS NOT AN EDGE CASE HERE. APFS and HFS+ are
 * case-insensitive by default, so "Interview.mp4" and "interview.mp4" are the
 * same file on the machines this app runs on. Comparing names case-sensitively
 * would report a clean batch and then have the second write silently clobber
 * the first. Every comparison below folds case for that reason.
 */

export type RenameToken =
  | "name"      // the original stem, extension stripped
  | "counter"   // 1-based position in the batch, {counter:03} to pad
  | "date"      // the item's own date, YYYY-MM-DD
  | "duration"  // H-MM-SS, safe for a filename (no colons)
  | "ext";      // the extension without the dot

/** One file going into a rename. */
export type RenameItem = {
  /** Absolute path, used as the identity of this row and for the extension. */
  path: string;
  /** Milliseconds, for {date}. Omit when unknown; {date} then renders "". */
  modifiedMs?: number | null;
  /** Seconds, for {duration}. Omit when unknown. */
  durationSec?: number | null;
};

export type RenamePlanRow = {
  path: string;
  /** Current filename including extension. */
  from: string;
  /** Proposed filename including extension. */
  to: string;
  /** Why this row cannot be applied, or null when it is fine. */
  problem: string | null;
};

export type RenamePlan = {
  rows: RenamePlanRow[];
  /** True when every row is applicable. Nothing should be written otherwise. */
  ok: boolean;
  /** Rows that would change something. A no-op row is valid but not work. */
  changed: number;
};

/** The stem, with the final extension removed. */
export function stemOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension: ".zshrc" has stem ".zshrc".
  return i > 0 ? filename.slice(0, i) : filename;
}

/** The extension without its dot, or "" when there is none. */
export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i + 1) : "";
}

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/** H-MM-SS. Colons are illegal in a filename, so this is not a timecode. */
function durationToken(sec: number | null | undefined): string {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}-${String(m).padStart(2, "0")}-${String(s).padStart(2, "0")}`;
}

/** YYYY-MM-DD in LOCAL time: the user's sense of "when" is their own clock. */
function dateToken(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Characters a name may not contain.
 *
 * `/` is the path separator. `:` looks legal and is not: HFS used it as the
 * separator, and Finder still displays a `:` in a name as a `/`, so allowing it
 * produces a file whose name in Finder is not the name on disk. Control
 * characters are rejected because they are invisible in every UI that would
 * show the result.
 */
const ILLEGAL = /[/:\x00-\x1f]/;

/** Expand one pattern for one item. Unknown tokens are left as written. */
export function expandPattern(
  pattern: string,
  item: RenameItem,
  index: number,
): string {
  const file = baseName(item.path);
  return pattern.replace(/\{(\w+)(?::(\d+))?\}/g, (whole, token: string, pad?: string) => {
    switch (token as RenameToken) {
      case "name": return stemOf(file);
      case "ext": return extOf(file);
      case "date": return dateToken(item.modifiedMs);
      case "duration": return durationToken(item.durationSec);
      case "counter": {
        const n = String(index + 1);
        return pad ? n.padStart(Number(pad), "0") : n;
      }
      // An unrecognised token stays literal rather than becoming "undefined" or
      // vanishing: the user sees their typo in the preview and can fix it.
      default: return whole;
    }
  });
}

/**
 * Build the full plan, with every row's problem decided.
 *
 * `existing` is every filename ALREADY in the same folders, so a rename can be
 * caught colliding with a file that was never selected. Without it the preview
 * would be green right up until the write failed or overwrote something.
 */
export function buildRenamePlan(
  items: readonly RenameItem[],
  pattern: string,
  existing: readonly string[] = [],
): RenamePlan {
  const trimmed = pattern.trim();
  const rows: RenamePlanRow[] = [];

  // Case-folded, because the filesystem is. Keyed by folder so two files with
  // the same new name in DIFFERENT folders are not a collision.
  const takenInBatch = new Map<string, number>();
  const existingSet = new Set(existing.map((e) => e.toLowerCase()));

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const from = baseName(item.path);
    const ext = extOf(from);

    // The expansion BEFORE the extension is appended. Emptiness has to be
    // judged here: a pattern of "{date}" on an item with no date expands to
    // "", and appending ".mp4" to that yields a name whose stem is ".mp4"
    // under the leading-dot rule, so the empty check would miss it entirely and
    // the user would be told their name "starts with a dot" instead of that
    // their pattern produced nothing.
    const expanded = trimmed ? expandPattern(trimmed, item, i) : "";
    let to = expanded;
    // The extension is preserved unless the pattern names one itself. Losing an
    // extension on a bulk rename is how a folder of video becomes unopenable.
    if (ext && !to.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) to = `${to}.${ext}`;

    const key = `${dirName(item.path)}/${to}`.toLowerCase();
    let problem: string | null = null;

    if (!trimmed) problem = "Pattern is empty";
    else if (expanded.trim() === "") problem = "Pattern produced an empty name";
    else if (ILLEGAL.test(stemOf(to))) problem = "Name contains / or :";
    else if (to.startsWith(".")) problem = "Name would start with a dot (hidden file)";
    else if (to.length > 255) problem = "Name is too long";
    else if (takenInBatch.has(key)) problem = `Same name as row ${takenInBatch.get(key)! + 1}`;
    // A row keeping its own name is fine; colliding with a DIFFERENT existing
    // file is not.
    else if (existingSet.has(key) && to.toLowerCase() !== from.toLowerCase()) {
      problem = "A file with that name already exists";
    }

    if (!problem) takenInBatch.set(key, i);
    rows.push({ path: item.path, from, to, problem });
  }

  return {
    rows,
    ok: rows.length > 0 && rows.every((r) => r.problem === null),
    // Case-only renames DO count as changes: the filesystem is
    // case-insensitive but case-PRESERVING, so "interview" to "Interview" is a
    // real edit the user asked for and expects to see.
    changed: rows.filter((r) => r.problem === null && r.to !== r.from).length,
  };
}
