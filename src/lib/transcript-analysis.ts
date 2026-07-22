/**
 * Saved AI analysis for a transcript — a co-located `<base>.analysis.json`
 * sidecar, the twin of the r132 diarization sidecar.
 *
 * WHY co-location, not the review fingerprint or localStorage: analysis is a
 * property of THIS transcript (the SRT), not of the source video, so it should
 * NOT follow the source across a re-transcribe the way speaker names do. And
 * the transcripts the reader serves (past history's 50-cap, or source-less
 * scanned ones) have no reviewSourceKey/fingerprint to key on. A sidecar beside
 * the SRT moves and is evicted as one unit with it, and the scan already
 * indexes existence (`TranscriptFile.has_analysis`) with no per-file read.
 *
 * The Rust `save_transcript_analysis` writes it atomically (a torn file would
 * be a corrupt reuse); the frontend reads it with the existing
 * `read_text_file_capped`.
 */

import { invoke } from "@tauri-apps/api/core";
import type { SummaryStyle } from "../components/AiSummary";

export type TranscriptAnalysis = {
  schemaVersion: 1;
  /** LLM model id that produced it (LlmServerInfo.model_id). */
  model: string;
  generatedAt: number;
  /** The format/length knobs used, so a regenerate can match or differ. */
  style: SummaryStyle;
  /** The analysis body (Markdown). */
  markdown: string;
  /** Staleness guards vs the scan: if the SRT changed (inline edit /
   *  re-diarize rewrote it in place) after this ran, the analysis is stale. */
  srtSizeBytes: number;
  srtModifiedMs: number;
};

const ANALYSIS_READ_CAP = 4 * 1024 * 1024;

/** `Foo.srt` / `Foo.vtt` → `Foo.analysis.json`. TS mirror of Rust
 *  `analysis_sidecar_path`. */
export function analysisSidecarPath(srtPath: string): string {
  return srtPath.replace(/\.[^./\\]+$/, "") + ".analysis.json";
}

/** Read a transcript's saved analysis, or null when there is none / it's
 *  unreadable / malformed. Defensive like `loadChapters`. */
export async function loadAnalysis(srtPath: string): Promise<TranscriptAnalysis | null> {
  try {
    const raw = await invoke<string>("read_text_file_capped", {
      path: analysisSidecarPath(srtPath),
      maxBytes: ANALYSIS_READ_CAP,
    });
    if (typeof raw !== "string" || !raw) return null;
    const p = JSON.parse(raw) as Partial<TranscriptAnalysis>;
    if (p.schemaVersion !== 1 || typeof p.markdown !== "string") return null;
    return {
      schemaVersion: 1,
      model: typeof p.model === "string" ? p.model : "",
      generatedAt: typeof p.generatedAt === "number" ? p.generatedAt : 0,
      style: (p.style && typeof p.style === "object" ? p.style : { format: "bullets", length: "standard" }) as SummaryStyle,
      markdown: p.markdown,
      srtSizeBytes: typeof p.srtSizeBytes === "number" ? p.srtSizeBytes : 0,
      srtModifiedMs: typeof p.srtModifiedMs === "number" ? p.srtModifiedMs : 0,
    };
  } catch {
    return null; // no sidecar / read error → treat as "not analyzed yet"
  }
}

/** Persist a transcript's analysis atomically (Rust `save_transcript_analysis`).
 *  Best-effort — a failed write leaves the in-memory analysis intact. */
export async function saveAnalysis(srtPath: string, doc: TranscriptAnalysis): Promise<void> {
  await invoke("save_transcript_analysis", { srtPath, json: JSON.stringify(doc) });
}

/** Whether a saved analysis was made against a NEWER version of the SRT than
 *  what's on disk now — i.e. the transcript was edited/re-diarized since, so the
 *  analysis is stale and should offer a regenerate rather than show silently. */
export function analysisIsStale(
  doc: TranscriptAnalysis,
  currentSizeBytes: number,
  currentModifiedMs: number,
): boolean {
  // A changed size is the strong signal; mtime moving forward past the run is
  // the fallback (an in-place rewrite bumps mtime even at the same size).
  return doc.srtSizeBytes !== currentSizeBytes || currentModifiedMs > doc.generatedAt;
}
