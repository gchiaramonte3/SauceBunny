/**
 * Fingerprint bridge for speaker renames.
 *
 * Speaker overrides (renames / colors / aliases) are stored per-SRT-path in
 * localStorage (`saucebunny.speakerNames.<path>`, see transcript/helpers.tsx) —
 * fast to read on every render, but the KEY is a volatile absolute path. So
 * re-transcribing the same source (a new SRT in a new YYYY-MM folder), renaming
 * the file, or moving it orphaned every rename and the transcript reopened as
 * SPEAKER_00. That is the user's reported pain.
 *
 * This module adds a location-independent bridge WITHOUT changing how any
 * consumer reads overrides: a fingerprint index (`saucebunny.speakerNames.fpindex`)
 * maps the SAME content fingerprint reviews already use (reviewFingerprint —
 * name stem + duration + dimensions + size, so a moved/renamed/re-encoded-at-
 * same-params copy matches) to the overrides blob. App SEEDS a fresh path key
 * from the fingerprint on transcript open, and MIRRORS the path key back to the
 * fingerprint whenever names change. The path key stays the synchronous working
 * store everything reads; the fingerprint is the durable identity behind it.
 *
 * Source-less scanned transcripts have no fingerprint (no source metadata) and
 * fall back to path-keyed behaviour unchanged.
 */

import { reviewFingerprint } from "./review";
import { speakerOverridesKey } from "../components/transcript/helpers";

const FP_INDEX_KEY = "saucebunny.speakerNames.fpindex";

function loadIndex(): Record<string, string> {
  try {
    const raw = localStorage.getItem(FP_INDEX_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return p && typeof p === "object" ? (p as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveIndex(idx: Record<string, string>): void {
  try {
    localStorage.setItem(FP_INDEX_KEY, JSON.stringify(idx));
  } catch {
    /* quota — the path key still holds the names for this session */
  }
}

/** The location-independent identity for a source's speaker renames — the SAME
 *  fingerprint reviews use, so a re-transcribe / rename / moved copy of the same
 *  source resolves to the same names. Null when there isn't enough source
 *  metadata (a source-less scanned transcript), which keeps the old path-only
 *  behaviour. */
export function speakerFingerprint(
  title: string | null | undefined,
  durationSec: number | null | undefined,
  w?: number | null,
  h?: number | null,
  sizeBytes?: number | null,
): string | null {
  if (!title && !durationSec) return null;
  return reviewFingerprint(title ?? "", durationSec ?? 0, w, h, sizeBytes);
}

/** The path key's overrides blob when it holds real names, else null. */
function pathBlob(path: string): string | null {
  try {
    const raw = localStorage.getItem(speakerOverridesKey(path));
    return raw && raw !== "{}" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * If the transcript at `path` has no saved names yet but this source's
 * fingerprint does, seed the path key from it — so a re-transcribe / rename
 * reopens with the names intact. Never clobbers names already on the path.
 * Returns true when it seeded (the caller fires SPEAKERS_CHANGED so live
 * consumers re-read).
 */
export function seedSpeakerOverridesFromFingerprint(path: string, fp: string | null): boolean {
  if (!fp || pathBlob(path)) return false;
  const blob = loadIndex()[fp];
  if (!blob) return false;
  try {
    localStorage.setItem(speakerOverridesKey(path), blob);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror the path key's current overrides into the fingerprint index so they
 * survive a future path change. Also MIGRATES: a transcript whose names predate
 * this bridge gets linked on first open. Clearing all names on the path removes
 * the fingerprint entry, so a later same-source transcript doesn't resurrect
 * deleted names.
 */
export function linkSpeakerOverridesToFingerprint(path: string, fp: string | null): void {
  if (!fp) return;
  const idx = loadIndex();
  const blob = pathBlob(path);
  if (blob) {
    if (idx[fp] === blob) return;
    idx[fp] = blob;
  } else {
    if (!(fp in idx)) return;
    delete idx[fp];
  }
  saveIndex(idx);
}
