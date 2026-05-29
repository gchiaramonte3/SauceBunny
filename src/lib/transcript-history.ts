/**
 * Per-machine transcript history. Lets the user:
 *   1. Re-open a recent transcript from the Transcript-tab history menu.
 *   2. Auto-load a transcript when they import the same source again
 *      (matched by file path for local files, by URL for web sources).
 *
 * Persisted to localStorage — small (1–2 KB per entry × N entries) and
 * doesn't need cross-device sync. Entries point to absolute file paths
 * on disk; the consumer is responsible for verifying the file still
 * exists before treating an entry as live.
 *
 * Why localStorage (not a Rust-backed file): zero extra IPC, instant
 * read on app boot for the history popover, and we deliberately want
 * this to be per-machine (the SRTs themselves are on this machine).
 */

const STORAGE_KEY = "saucebunny.transcriptHistory";
const MAX_ENTRIES = 50;

export type TranscriptHistoryEntry = {
  /** Stable id (uuid-ish). Used as React key + de-dup target. */
  id: string;
  /** Absolute path to the SRT file on disk. */
  srtPath: string;
  /**
   * Originating local file path, if the transcript was generated from
   * a local file. Mutually exclusive with sourceUrl in practice but we
   * allow both since edge cases (downloaded web source promoted to a
   * local file) could populate both.
   */
  sourcePath: string | null;
  /** Originating web URL when the source was a YouTube/web fetch. */
  sourceUrl: string | null;
  /**
   * Human-readable label for the history list — typically the SRT
   * filename without extension, or the source title when available.
   * Falls back to the SRT basename if neither was set at write time.
   */
  title: string;
  /** Producer — drives the small badge in the history list. */
  origin: "captions" | "whisper" | "unknown";
  /** Unix ms when the entry was first created. */
  createdAt: number;
  /** Unix ms when the entry was last loaded (via auto or history click). */
  lastOpenedAt: number;
};

function safeRead(): TranscriptHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — drop any malformed entries rather than
    // crashing the whole module. A corrupted entry would otherwise
    // poison every render of the history popover.
    return parsed.filter((x): x is TranscriptHistoryEntry =>
      x && typeof x === "object" &&
      typeof x.id === "string" &&
      typeof x.srtPath === "string" &&
      typeof x.title === "string" &&
      typeof x.origin === "string" &&
      typeof x.createdAt === "number" &&
      typeof x.lastOpenedAt === "number",
    );
  } catch {
    return [];
  }
}

function safeWrite(entries: TranscriptHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch { /* quota — best-effort, history isn't critical */ }
}

export function getHistory(): TranscriptHistoryEntry[] {
  // Sorted newest-first by lastOpenedAt so the popover shows the
  // most-recently-used entry at the top.
  return safeRead().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/**
 * Insert or update an entry. De-dup key: same srtPath OR same source
 * (path/url). When the same source produces a new SRT (e.g. re-Generate
 * with a different model), we keep the newer SRT path and bump
 * timestamps; the older SRT entry stays as a separate row only if its
 * srtPath is genuinely different.
 *
 * Trims to MAX_ENTRIES, evicting oldest by lastOpenedAt.
 */
export function recordTranscript(input: {
  srtPath: string;
  sourcePath?: string | null;
  sourceUrl?: string | null;
  title: string;
  origin: TranscriptHistoryEntry["origin"];
}): TranscriptHistoryEntry {
  const entries = safeRead();
  const now = Date.now();

  // Find a prior entry to update. Match on srtPath first (most specific),
  // then on sourcePath/sourceUrl (so re-transcribing the same source
  // updates the same row instead of accumulating duplicates).
  const existingIdx = entries.findIndex((e) =>
    e.srtPath === input.srtPath ||
    (input.sourcePath && e.sourcePath === input.sourcePath) ||
    (input.sourceUrl  && e.sourceUrl  === input.sourceUrl),
  );

  const merged: TranscriptHistoryEntry = existingIdx >= 0
    ? {
        ...entries[existingIdx],
        srtPath: input.srtPath,
        sourcePath: input.sourcePath ?? entries[existingIdx].sourcePath,
        sourceUrl:  input.sourceUrl  ?? entries[existingIdx].sourceUrl,
        title: input.title,
        origin: input.origin,
        lastOpenedAt: now,
      }
    : {
        id: `tx-${now}-${Math.random().toString(36).slice(2, 8)}`,
        srtPath: input.srtPath,
        sourcePath: input.sourcePath ?? null,
        sourceUrl:  input.sourceUrl  ?? null,
        title: input.title,
        origin: input.origin,
        createdAt: now,
        lastOpenedAt: now,
      };

  if (existingIdx >= 0) entries.splice(existingIdx, 1, merged);
  else entries.push(merged);

  // Trim to MAX_ENTRIES — evict oldest by lastOpenedAt.
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    entries.length = MAX_ENTRIES;
  }

  safeWrite(entries);
  return merged;
}

/** Mark an entry as recently-opened without changing other fields. */
export function touchEntry(id: string): void {
  const entries = safeRead();
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  entries[i] = { ...entries[i], lastOpenedAt: Date.now() };
  safeWrite(entries);
}

/** Remove an entry by id — for the history popover's per-row delete. */
export function removeEntry(id: string): void {
  safeWrite(safeRead().filter((e) => e.id !== id));
}

/** Wipe everything. Used by a future "Clear history" action. */
export function clearHistory(): void {
  safeWrite([]);
}

/**
 * Find the most-recent entry matching a source. Used on import/fetch
 * to auto-load a prior transcript. Returns null when nothing matches
 * — the caller decides whether to also check the disk (the entry's
 * srtPath might be stale).
 */
export function findForSource(input: {
  sourcePath?: string | null;
  sourceUrl?: string | null;
}): TranscriptHistoryEntry | null {
  if (!input.sourcePath && !input.sourceUrl) return null;
  const entries = safeRead();
  const matches = entries.filter((e) =>
    (input.sourcePath != null && e.sourcePath === input.sourcePath) ||
    (input.sourceUrl  != null && e.sourceUrl  === input.sourceUrl),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return matches[0];
}

/**
 * Format a Unix ms timestamp as "2m ago" / "3h ago" / "yesterday" /
 * "May 23". Compact for a popover row.
 */
export function formatTimeAgo(ms: number, now = Date.now()): string {
  const delta = Math.max(0, now - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 60)         return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60)         return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)          return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1)        return "yesterday";
  if (day < 7)          return `${day}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
