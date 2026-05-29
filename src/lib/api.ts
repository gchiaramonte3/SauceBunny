/**
 * Typed wrapper around every Tauri command Sauce Bunny exposes.
 *
 * Why this layer exists:
 *  - Centralises the surface area when @tauri-apps/api bumps a major
 *    version (the breaking change lives in one file, not 40).
 *  - Catches Rust-command renames at compile time. If `commands.rs`
 *    renames `transcribe_local_file`, every caller breaks here, not
 *    at runtime in a random component.
 *  - Acts as documentation: a new contributor reads this file and
 *    knows the entire backend surface in one scroll.
 *
 * Components should import `api` from this module, not call `invoke()`
 * directly. The legacy direct-invoke call sites in App.tsx + a few
 * components will be migrated in a dedicated cleanup round (see
 * ARCHITECTURE.md → Roadmap). New code MUST use this wrapper.
 *
 * Arg-struct types are kept loose here (`Record<string, unknown>`)
 * where the Rust struct shape isn't already mirrored in src/types.ts —
 * sharpen them when the corresponding TS type lands. The compile-time
 * win is biggest on RETURN types (which Rust drives) and on the
 * command NAMES (which can rename silently); arg-shape drift is rarer.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Metadata,
  LocalFileMeta,
  WhisperModel,
} from "../types";

// ── Backend-shaped types that don't live in types.ts yet ────────────
// When you add proper types in src/types.ts, replace these.

/** Mirror of CacheStats in src-tauri/src/commands.rs. */
export type CacheStats = {
  file_count: number;
  bytes_total: number;
  path?: string;
};

// Loose stand-ins for arg shapes — Rust defines the canonical struct.
// Sharpening these is welcome.
type ClipArgs                  = Record<string, unknown>;
type CaptionsArgs              = Record<string, unknown>;
type DownloadModelArgs         = Record<string, unknown>;
type GenerateTranscriptArgs    = Record<string, unknown>;
type TranscribeLocalArgs       = Record<string, unknown>;
type TranscribePreparedWavArgs = Record<string, unknown>;
type DownloadWebPreviewArgs    = Record<string, unknown>;
type ExtractFrameArgs          = Record<string, unknown>;
type ExtractLocalFrameArgs     = Record<string, unknown>;
type LocalThumbnailArgs        = Record<string, unknown>;
type PreparePlaybackArgs       = Record<string, unknown>;
type DiarizeArgs               = Record<string, unknown>;

// ── The client ──────────────────────────────────────────────────────

export const api = {
  meta: {
    backendBuildId: () => invoke<string>("get_backend_build_id"),
    newJobId:       () => invoke<string>("new_job_id"),
  },

  source: {
    fetchMetadata:    (url: string)                     => invoke<Metadata>("fetch_metadata", { url }),
    probeLocal:       (path: string)                    => invoke<LocalFileMeta>("probe_local_file", { path }),
    getDirectStream:  (url: string)                     => invoke<string>("get_direct_stream_url", { url }),
    downloadWebPrev:  (args: DownloadWebPreviewArgs)    => invoke<string>("download_web_preview", { args }),
  },

  clip: {
    create:           (args: ClipArgs)                  => invoke<string>("create_clip", { args }),
  },

  captions: {
    download:         (args: CaptionsArgs)              => invoke<string>("download_captions", { args }),
  },

  whisper: {
    listModels:       ()                                => invoke<WhisperModel[]>("list_whisper_models"),
    downloadModel:    (args: DownloadModelArgs)         => invoke<string>("download_whisper_model", { args }),
    deleteModel:      (id: string)                      => invoke<void>("delete_whisper_model", { id }),
    generate:         (args: GenerateTranscriptArgs)    => invoke<string>("generate_transcript", { args }),
    transcribeLocal:  (args: TranscribeLocalArgs)       => invoke<string>("transcribe_local_file", { args }),
    transcribePrepared: (args: TranscribePreparedWavArgs) => invoke<string>("transcribe_prepared_wav", { args }),
  },

  diarize: {
    probe:            ()                                => invoke<string>("probe_diarizer"),
    prepareModels:    (jobId: string)                   => invoke<string>("prepare_diarizer_models", { jobId }),
    run:              (args: DiarizeArgs)               => invoke<string>("run_diarizer", { args }),
  },

  playback: {
    prepLocal:        (args: PreparePlaybackArgs)       => invoke<string>("prepare_local_for_playback", { args }),
    extractFrame:     (args: ExtractFrameArgs)          => invoke<number[]>("extract_frame", { args }),
    extractLocalFrame:(args: ExtractLocalFrameArgs)     => invoke<number[]>("extract_local_frame", { args }),
    generateThumb:    (args: LocalThumbnailArgs)        => invoke<string>("generate_local_thumbnail", { args }),
  },

  fs: {
    saveBytes:        (path: string, bytes: number[])   => invoke<void>("write_bytes_to_path", { path, bytes }),
    revealInFinder:   (path: string)                    => invoke<void>("reveal_in_finder", { path }),
    readTextCapped:   (path: string, maxBytes?: number) => invoke<string>("read_text_file_capped", { path, maxBytes }),
    ensureDir:        (path: string)                    => invoke<void>("ensure_dir_exists", { path }),
    defaultTranscriptLibrary: ()                        => invoke<string>("default_transcript_library_path"),
  },

  cache: {
    stats:            ()                                => invoke<CacheStats>("get_cache_stats"),
    clear:            ()                                => invoke<number>("clear_all_cache"),
    cleanupStale:     ()                                => invoke<number>("cleanup_stale_cache"),
  },

  control: {
    cancelJob:        (jobId: string)                   => invoke<void>("cancel_job", { jobId }),
  },
};
