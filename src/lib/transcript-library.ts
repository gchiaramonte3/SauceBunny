/**
 * The transcript library: every transcript ON DISK, merged with its history
 * entry when one exists.
 *
 * The Home "Transcribed" shelf and the transcript history menu read
 * localStorage (transcript-history.ts), which is capped at 50 entries — so a
 * transcript past that cap, or after the history is cleared, was invisible even
 * though the .srt is right there under ~/Documents/Sauce Bunny/Transcripts/.
 * This module scans that folder (Rust `scan_transcript_library`) so ALL
 * transcripts surface, and reconciles each with its history entry so opening it
 * can still follow along with the source video when we know where that is.
 *
 * The scan is authoritative for "what exists"; history adds source linkage
 * (url / local path / title / producer). A scanned transcript with no history
 * entry gets a synthesized one so the SAME open handler works — it opens the
 * transcript standalone (App's onOpenTranscriptHistory already handles a
 * source-less entry gracefully).
 */

import { invoke } from "@tauri-apps/api/core";
import type { TranscriptFile } from "../bindings/TranscriptFile";
import { getHistory, type TranscriptHistoryEntry } from "./transcript-history";

/** One transcript in the library view. `entry` is real or synthesized and is
 *  always safe to pass to App's transcript-open handler. */
export type LibraryTranscript = {
  /** Absolute .srt / .vtt path — the stable identity. */
  path: string;
  /** History title when known, else the filename stem. */
  title: string;
  /** Parent folder label from the scan (e.g. "2026-07"); "" when at the root. */
  folder: string;
  modifiedMs: number;
  sizeBytes: number;
  format: string;
  /** A co-located `.diarization.json` sidecar exists (r132) → has speakers. */
  hasDiarization: boolean;
  /** True when a history entry matched — so we know its source and can follow
   *  along with the video; false = transcript-only (opens standalone). */
  inHistory: boolean;
  entry: TranscriptHistoryEntry;
};

/** A minimal history entry for a scanned transcript with no real one, so it can
 *  be opened through the exact same path (source-less → opens on its own). */
export function synthesizeEntry(t: TranscriptFile): TranscriptHistoryEntry {
  return {
    id: `scan:${t.path}`,
    srtPath: t.path,
    sourcePath: null,
    sourceUrl: null,
    title: t.name,
    origin: "unknown",
    createdAt: t.modified_ms,
    lastOpenedAt: t.modified_ms,
  };
}

/** Filename stem for a path — the display fallback when there's no title. */
function stemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * UNION of what's on disk (the scan) with what history knows. Pure, so it's
 * unit-testable without touching disk. Newest first.
 *
 * The scan is authoritative for what exists and carries the rich metadata
 * (folder, size, diarization). But a history entry the scan didn't reach — a
 * transcript saved to a custom location, or one the scan couldn't read — still
 * belongs: the user made it. Those are added from history alone. Deduped by
 * absolute path.
 */
export function mergeTranscriptLibrary(
  files: TranscriptFile[],
  history: TranscriptHistoryEntry[],
): LibraryTranscript[] {
  const byPath = new Map(history.map((h) => [h.srtPath, h] as const));
  const seen = new Set<string>();
  const out: LibraryTranscript[] = [];

  for (const t of files) {
    seen.add(t.path);
    const h = byPath.get(t.path);
    out.push({
      path: t.path,
      title: h?.title?.trim() || t.name,
      folder: t.folder,
      modifiedMs: t.modified_ms,
      sizeBytes: t.size_bytes,
      format: t.format,
      hasDiarization: t.has_diarization,
      inHistory: !!h,
      entry: h ?? synthesizeEntry(t),
    });
  }
  for (const h of history) {
    if (seen.has(h.srtPath)) continue;
    seen.add(h.srtPath);
    out.push({
      path: h.srtPath,
      title: h.title?.trim() || stemOf(h.srtPath),
      folder: "", // unknown without the scan → the "Other" group
      modifiedMs: h.lastOpenedAt || h.createdAt || 0,
      sizeBytes: 0,
      format: h.srtPath.toLowerCase().endsWith(".vtt") ? "vtt" : "srt",
      hasDiarization: false, // the scan is what flags the sidecar
      inHistory: true,
      entry: h,
    });
  }
  out.sort((a, b) => b.modifiedMs - a.modifiedMs || a.title.localeCompare(b.title));
  return out;
}

/** Scan the transcript library at `libraryPath` and reconcile with history.
 *  Empty (never throws) when the path is unset or the scan fails. */
export async function loadTranscriptLibrary(libraryPath: string): Promise<LibraryTranscript[]> {
  // History is ALWAYS shown (it's the union base). The scan just adds the
  // on-disk transcripts when a library path is available — before the default
  // path resolves at boot, or a scan failure, still shows history.
  let files: TranscriptFile[] = [];
  if (libraryPath?.trim()) {
    try {
      const r = await invoke<TranscriptFile[]>("scan_transcript_library", { path: libraryPath });
      // A mocked backend (e2e) or a stale binary can return a non-array; never
      // let that reach .map().
      if (Array.isArray(r)) files = r;
    } catch {
      /* missing library / scan failure → fall back to history alone */
    }
  }
  return mergeTranscriptLibrary(files, getHistory());
}

/** Group a transcript list by its folder label (the YYYY-MM month), newest
 *  group first, for the "auto-sort folder" view. Root-level ("") sorts last
 *  under a friendly label. */
export function groupTranscriptsByFolder(
  list: LibraryTranscript[],
): { folder: string; label: string; items: LibraryTranscript[] }[] {
  const groups = new Map<string, LibraryTranscript[]>();
  for (const t of list) {
    const arr = groups.get(t.folder);
    if (arr) arr.push(t);
    else groups.set(t.folder, [t]);
  }
  return [...groups.entries()]
    .map(([folder, items]) => ({ folder, label: monthLabel(folder), items }))
    // The lists are already newest-first; order groups by their newest item.
    .sort((a, b) => (b.items[0]?.modifiedMs ?? 0) - (a.items[0]?.modifiedMs ?? 0));
}

/** "2026-07" → "July 2026"; anything else (incl. "") → "Other". */
export function monthLabel(folder: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(folder);
  if (!m) return "Other";
  const monthIdx = Number(m[2]) - 1;
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[monthIdx] ?? folder} ${m[1]}`;
}
