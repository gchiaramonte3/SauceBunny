import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  extractFrameAsBlob,
  extractPosterBlob,
  probeVideoDuration,
} from "../lib/mediabunny-helpers";
import { formatError } from "../lib/error-format";
import {
  LIBRARY_SCAN_DEPTH,
  chosenPosterFor,
  clearChosenPoster,
  loadLibraryRoots,
  saveLibraryRoots,
} from "../lib/library";
import type { LibraryFolder } from "../types";

// ════════════════════════════════════════════════════════════════════════
// Poster loader — module scope so the cache is one per app, shared by every
// card/hero and alive across re-renders. Cards call this only once visible
// (use-lazy-thumbnails), and at most THUMB_CONCURRENCY decodes run at once.
//
// Two-step pipeline, mirroring the import thumbnail in App.tsx loadLocalPath:
//   1. mediabunny extractPosterBlob — in-process WebCodecs decode (~20-80ms,
//      no subprocess) of the representative (or user-chosen) frame, yields a
//      blob: object URL.
//   2. generate_local_thumbnail — the ffmpeg fallback for codecs WebCodecs
//      can't decode; has its own (path, mtime, time)-keyed disk cache, yields
//      an asset:// URL via convertFileSrc.
// Total failure marks the path bad for the session → placeholder, no retry
// loop. The poster frame is representative (extractPosterBlob skips black
// intro fades) or, when the user picked one, that exact timestamp.
//
// Lives in this hook module (not LibraryView) because BOTH the Home shelves
// and the Library browser drive it — one cache, one concurrency gate.
// ════════════════════════════════════════════════════════════════════════

/** path → displayable URL. Map insertion order doubles as the eviction queue. */
const thumbCache = new Map<string, string>();
const thumbPending = new Map<string, Promise<string | null>>();
/** Paths that failed both steps — placeholder without re-decoding forever. */
const thumbFailed = new Set<string>();
const THUMB_CACHE_MAX = 400;
const THUMB_CONCURRENCY = 3;

let thumbRunning = 0;
const thumbWaiters: Array<() => void> = [];
/** Fired when a poster URL lands in the cache — the ambient backdrop subscribes
 *  so it can pick up frames the library cards materialize AFTER it first
 *  rendered (its parent doesn't re-render on a card's async thumbnail load). */
const thumbListeners = new Set<() => void>();
/** path → decode generation. invalidateThumb bumps it so a decode already in
 *  flight when the user picks a new poster discards its now-stale result
 *  instead of racing the fresh one into the cache. */
const thumbGen = new Map<string, number>();

/**
 * Acquire one of the THUMB_CONCURRENCY decode slots around `job`. ONE gate for
 * every mediabunny/ffmpeg decode this module runs — card posters, hero stills,
 * and hover preview frames — so the total simultaneous decode load stays
 * capped no matter which surface asks. The finally runs on both resolve and
 * reject, so a failed decode never leaks a slot or strands a queued waiter.
 */
async function withDecodeSlot<T>(job: () => Promise<T>): Promise<T> {
  if (thumbRunning >= THUMB_CONCURRENCY) {
    await new Promise<void>((release) => thumbWaiters.push(release));
  }
  thumbRunning++;
  try {
    return await job();
  } finally {
    thumbRunning--;
    thumbWaiters.shift()?.();
  }
}

function rememberThumb(path: string, url: string): void {
  // Overwriting an existing entry (e.g. a duplicate same-path job) must release
  // the prior blob, not just the LRU-evicted ones, or the old decode leaks.
  const prior = thumbCache.get(path);
  if (prior && prior !== url && prior.startsWith("blob:")) URL.revokeObjectURL(prior);
  thumbCache.set(path, url);
  for (const cb of thumbListeners) cb();
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.entries().next().value;
    if (!oldest) break;
    thumbCache.delete(oldest[0]);
    // blob: URLs pin decoded JPEGs in memory — release on eviction. (A still
    // -mounted <img> holding one degrades to the placeholder via onError.)
    if (oldest[1].startsWith("blob:")) URL.revokeObjectURL(oldest[1]);
  }
}

async function loadThumbnail(path: string): Promise<string | null> {
  // A user-chosen poster time overrides the representative frame; null → auto.
  const chosen = chosenPosterFor(path);
  const blob = await extractPosterBlob(path, {
    atSeconds: chosen ?? undefined,
    maxWidth: 480,
    quality: 0.8,
  });
  if (blob) return URL.createObjectURL(blob);
  const out = await invoke<string>("generate_local_thumbnail", {
    args: { input_path: path, duration_seconds: null, time_seconds: chosen ?? null },
  });
  return typeof out === "string" && out !== "" ? convertFileSrc(out) : null;
}

/**
 * Bust one path's cached poster so the next request regenerates it — called
 * after a "Set thumbnail…" change. Revokes the old blob URL to free the decoded
 * JPEG, and clears the failed/pending bookkeeping so a fresh decode can run.
 * The card is re-requested by remounting it (a poster-version key in the
 * consumers below), which re-runs its lazy-thumbnail hook against this cleared
 * cache.
 */
export function invalidateThumb(path: string): void {
  const url = thumbCache.get(path);
  if (url) {
    thumbCache.delete(path);
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  thumbFailed.delete(path);
  thumbPending.delete(path);
  // Hero stills and hover frames are derived from the same source frame set —
  // a poster invalidation evicts them too (each helper revokes its blobs).
  evictHeroStill(path);
  evictHoverFrames(path);
  // Supersede any decode already in flight for this path (the ffmpeg fallback
  // can take a while): the running job will see the bumped generation and drop
  // its stale result rather than overwriting the cache with the old poster.
  // Hero/hover jobs snapshot the SAME generation, so one bump supersedes all
  // three kinds of in-flight decode at once.
  thumbGen.set(path, (thumbGen.get(path) ?? 0) + 1);
}

/**
 * Snapshot of every poster URL already materialized in the cache — a pure read
 * of the shared thumbCache (blob:/asset:// URLs), NO decode or scan triggered.
 * The ambient backdrop samples these already-paid-for frames; it must never
 * cause new work, so this only surfaces what the cards have organically loaded.
 */
export function listThumbs(): string[] {
  return Array.from(thumbCache.values());
}

/**
 * Subscribe to cache growth — the callback fires whenever a new poster URL is
 * cached. Returns an unsubscribe fn. Used by the ambient backdrop to re-read
 * listThumbs() as cards fill the cache (a pure notification, no decode/scan).
 */
export function subscribeThumbs(cb: () => void): () => void {
  thumbListeners.add(cb);
  return () => { thumbListeners.delete(cb); };
}

/** Cached + de-duped + concurrency-capped poster fetch for one video path. */
export function requestThumbnail(path: string): Promise<string | null> {
  const hit = thumbCache.get(path);
  if (hit) return Promise.resolve(hit);
  if (thumbFailed.has(path)) return Promise.resolve(null);
  const pending = thumbPending.get(path);
  if (pending) return pending;
  // Snapshot the generation now; invalidateThumb bumps it if the user picks a
  // new poster while this job is decoding, which is how the job detects it was
  // superseded (see the checks below).
  const startGen = thumbGen.get(path) ?? 0;
  const current = () => (thumbGen.get(path) ?? 0) === startGen;
  const job = (async () => {
    try {
      const url = await withDecodeSlot(() => loadThumbnail(path));
      // Superseded mid-decode: discard rather than caching a stale frame, and
      // revoke the blob we just made so it doesn't leak. A newer job (spawned
      // by the remounted card) owns the poster now.
      if (!current()) {
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        return null;
      }
      if (url) rememberThumb(path, url);
      else thumbFailed.add(path);
      return url;
    } catch {
      // Don't poison a path with a failure flag if a pick superseded us.
      if (current()) thumbFailed.add(path);
      return null;
    } finally {
      // Only clear the pending slot if we still own it. If a pick superseded us,
      // a newer job now holds thumbPending — deleting it would defeat dedup.
      if (current()) thumbPending.delete(path);
    }
  })();
  thumbPending.set(path, job);
  return job;
}

// ════════════════════════════════════════════════════════════════════════
// Hero still — the Home hero's sharp full-band art, also the Continue row's
// featured (`large`) card posters. Same two-step idea as the posters but
// decoded at hero resolution: the 480px card poster upscaled across a
// ~1000px band (or a 432px card on Retina) reads soft, and the hero grammar
// (a SHARP still dissolving into the page) depends on crisp pixels. Small
// cache — one hero + the featured row rotate through it.
// ════════════════════════════════════════════════════════════════════════

const heroCache = new Map<string, string>();
const heroPending = new Map<string, Promise<string | null>>();
/** One hero + up to 8 Continue-row featured cards (which also decode at hero
 *  resolution) must fit WITHOUT LRU churn — an eviction revokes the blob a
 *  still-mounted <img> may re-request on remount. */
const HERO_CACHE_MAX = 12;

function rememberHeroStill(path: string, url: string): void {
  const prior = heroCache.get(path);
  if (prior && prior !== url) URL.revokeObjectURL(prior);
  heroCache.set(path, url);
  while (heroCache.size > HERO_CACHE_MAX) {
    const oldest = heroCache.entries().next().value;
    if (!oldest) break;
    heroCache.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]); // hero stills are always blob: URLs
  }
}

/** invalidateThumb's hero hook — evict + revoke so a new pick can't show stale art. */
function evictHeroStill(path: string): void {
  const url = heroCache.get(path);
  if (url) {
    heroCache.delete(path);
    URL.revokeObjectURL(url);
  }
  heroPending.delete(path);
}

/**
 * Cached + de-duped hero-resolution poster fetch. Shares the poster pipeline's
 * decode gate, chosen-poster override, failure bookkeeping (a path that failed
 * the poster pipeline is never retried here), and generation guard. When
 * WebCodecs can't decode the file it falls through to requestThumbnail (whose
 * ffmpeg fallback owns that case) — soft art beats a blank band.
 */
export function requestHeroStill(path: string): Promise<string | null> {
  const hit = heroCache.get(path);
  if (hit) return Promise.resolve(hit);
  if (thumbFailed.has(path)) return Promise.resolve(null);
  const pending = heroPending.get(path);
  if (pending) return pending;
  const startGen = thumbGen.get(path) ?? 0;
  const current = () => (thumbGen.get(path) ?? 0) === startGen;
  const job = (async () => {
    try {
      const chosen = chosenPosterFor(path);
      const blob = await withDecodeSlot(() =>
        extractPosterBlob(path, {
          atSeconds: chosen ?? undefined,
          maxWidth: 1600,
          quality: 0.85,
        }),
      );
      if (!current()) return null; // superseded — a newer job owns the hero now
      if (blob) {
        const url = URL.createObjectURL(blob);
        rememberHeroStill(path, url);
        return url;
      }
      // Not decodable in-process → the card poster path (ffmpeg fallback +
      // thumbFailed bookkeeping live there). Its URL belongs to thumbCache —
      // do NOT put it in heroCache, or eviction would revoke it twice.
      return await requestThumbnail(path);
    } catch {
      return current() ? requestThumbnail(path) : null;
    } finally {
      if (current()) heroPending.delete(path);
    }
  })();
  heroPending.set(path, job);
  return job;
}

// ════════════════════════════════════════════════════════════════════════
// Hover preview frames — the card hover cycle (use-hover-frames.ts). Up to
// three extra frames at 25/50/75% of duration, decoded LAZILY on hover
// intent (never on render), through the same decode gate and generation
// guard as the posters. Own small LRU (revoke-on-evict) so a burst of
// hovered cards can't grow memory unbounded or churn the poster cache.
// ════════════════════════════════════════════════════════════════════════

const HOVER_FRACS = [0.25, 0.5, 0.75] as const;
const hoverCache = new Map<string, string>(); // `${path}#${frac}` → blob: URL
const hoverPending = new Map<string, Promise<string[]>>();
/** Paths whose hover decode failed (bad duration / no decodable frame) — the
 *  poster stays, and re-hovers don't spin up a doomed decode every 600ms. */
const hoverFailed = new Set<string>();
/** Individual `${path}#${frac}` frames that resolved null while siblings
 *  succeeded — treated as settled so a partial failure doesn't re-probe the
 *  duration and re-attempt the doomed decode on every re-hover. Cleared with
 *  the path's frames (evictHoverFrames) so a poster pick/reset re-arms retries. */
const hoverFracFailed = new Set<string>();
const HOVER_CACHE_MAX = 120; // 40 videos × 3 frames

function rememberHoverFrame(key: string, url: string): void {
  const prior = hoverCache.get(key);
  if (prior && prior !== url) URL.revokeObjectURL(prior);
  hoverCache.set(key, url);
  while (hoverCache.size > HOVER_CACHE_MAX) {
    const oldest = hoverCache.entries().next().value;
    if (!oldest) break;
    hoverCache.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]); // hover frames are always blob: URLs
  }
}

/** invalidateThumb's hover hook — a poster pick/reset drops the derived frames. */
function evictHoverFrames(path: string): void {
  for (const frac of HOVER_FRACS) {
    const key = `${path}#${frac}`;
    const url = hoverCache.get(key);
    if (url) {
      hoverCache.delete(key);
      URL.revokeObjectURL(url);
    }
    hoverFracFailed.delete(key);
  }
  hoverFailed.delete(path);
  hoverPending.delete(path);
}

/**
 * The hover cycle's frame fetch: up to three frames at 25/50/75% of the
 * file's duration, cached per-frame (`path#frac`), de-duped in flight per
 * path, and gated through the shared decode slots. Bails to [] for paths the
 * poster pipeline already marked bad. No ffmpeg fallback here — a frame that
 * won't decode in-process just leaves the poster covering that beat of the
 * cycle. Callers only invoke this after hover intent (see use-hover-frames).
 */
export function requestHoverFrames(path: string): Promise<string[]> {
  if (thumbFailed.has(path) || hoverFailed.has(path)) return Promise.resolve([]);
  // A frac is settled once it's cached OR known-undecodable — a partial
  // failure must not re-probe duration and re-attempt the doomed frac forever.
  const settled = HOVER_FRACS.every((f) => {
    const key = `${path}#${f}`;
    return hoverCache.has(key) || hoverFracFailed.has(key);
  });
  if (settled) {
    return Promise.resolve(
      HOVER_FRACS.map((f) => hoverCache.get(`${path}#${f}`))
        .filter((u): u is string => u != null),
    );
  }
  const pending = hoverPending.get(path);
  if (pending) return pending;
  const startGen = thumbGen.get(path) ?? 0;
  const current = () => (thumbGen.get(path) ?? 0) === startGen;
  const job = (async () => {
    try {
      const dur = await withDecodeSlot(() => probeVideoDuration(path));
      if (!current()) return [];
      if (!dur) {
        hoverFailed.add(path);
        return [];
      }
      const out: string[] = [];
      for (const frac of HOVER_FRACS) {
        const key = `${path}#${frac}`;
        const hit = hoverCache.get(key);
        if (hit) {
          // Touch the hit to the Map tail: this same call's LATER insertions
          // could otherwise LRU-evict + revoke a URL we're about to return.
          hoverCache.delete(key);
          hoverCache.set(key, hit);
          out.push(hit);
          continue;
        }
        if (hoverFracFailed.has(key)) continue; // settled — don't re-attempt
        const blob = await withDecodeSlot(() =>
          extractFrameAsBlob(path, dur * frac, { maxWidth: 480, quality: 0.8 }),
        );
        // Superseded mid-cycle: frames cached before the invalidation were
        // already evicted+revoked by evictHoverFrames; drop the rest.
        if (!current()) return [];
        if (!blob) {
          hoverFracFailed.add(key);
          continue;
        }
        const url = URL.createObjectURL(blob);
        rememberHoverFrame(key, url);
        out.push(url);
      }
      if (out.length === 0) hoverFailed.add(path);
      return out;
    } catch {
      if (current()) hoverFailed.add(path);
      return [];
    } finally {
      if (current()) hoverPending.delete(path);
    }
  })();
  hoverPending.set(path, job);
  return job;
}

// ── Scan state ────────────────────────────────────────────────────────────

export type RootScan =
  | { status: "loading" }
  | { status: "ok"; tree: LibraryFolder }
  | { status: "error"; message: string };

export type LibraryScan = {
  /** Persisted root folders the user added (order preserved). */
  roots: string[];
  /** Per-root scan result (loading / ok tree / error). */
  scans: Record<string, RootScan>;
  /** True while any root is mid-scan — disables the rescan controls. */
  scanning: boolean;
  /** Native folder picker → add + scan a new root. */
  addFolder: () => Promise<void>;
  /** Forget a root (never touches disk). Confirms first. */
  removeRoot: (root: string) => void;
  /** Re-run every root's scan sequentially. */
  rescanAll: () => void;
  /** Re-scan one root (the inline error row's Retry). */
  scanRoot: (root: string) => void;
  /** Shared, cached, concurrency-capped poster loader. */
  requestThumb: (path: string) => Promise<string | null>;
  /** Bust one path's cached poster (race-guarded blob revoke). */
  invalidateThumb: (path: string) => void;
  /** path → poster version — bump changes a card's key so it remounts. */
  posterVersions: Record<string, number>;
  /** Bump a path's poster version (remount its card). */
  bumpPoster: (path: string) => void;
  /** Clear a chosen thumbnail → auto frame, busting cache + remounting. */
  resetPoster: (path: string) => void;
};

/**
 * The single owner of library scan state, shared by every view.
 *
 * App calls this ONCE and passes the result into both the Home shelves
 * (LibraryView) and the Library browser (LibraryBrowser), so scan RESULTS are
 * shared — switching between the two never rescans. Scans run on mount and on
 * explicit actions (add root, retry, rescan), one root at a time — never on a
 * timer. This satisfies the constitution's 3+-consumer hook rule the moment
 * both views consume it.
 */
export function useLibraryScan(): LibraryScan {
  const [roots, setRoots] = useState<string[]>(() => loadLibraryRoots());
  const [scans, setScans] = useState<Record<string, RootScan>>({});
  // "Set thumbnail…" per-path poster version. Bumping a path's version changes
  // the matching card's React key across BOTH views, remounting it so its
  // lazy-thumbnail hook re-requests the (invalidated) poster.
  const [posterVersions, setPosterVersions] = useState<Record<string, number>>({});
  const scanSweepRef = useRef(0);

  const bumpPoster = useCallback(
    (path: string) => setPosterVersions((v) => ({ ...v, [path]: (v[path] ?? 0) + 1 })),
    [],
  );
  const resetPoster = useCallback((path: string) => {
    clearChosenPoster(path);
    invalidateThumb(path);
    bumpPoster(path);
  }, [bumpPoster]);

  // ── Scan orchestration — sequential, never a Promise.all fan-out ──────
  const scanOne = useCallback(async (root: string) => {
    // Snapshot the sweep token so a rescan/removal that supersedes us mid-scan
    // can't let this stale result clobber the newer state — scanAll only checks
    // the token between roots, never after this async scan lands.
    const sweep = scanSweepRef.current;
    setScans((s) => ({ ...s, [root]: { status: "loading" } }));
    try {
      const tree = await invoke<LibraryFolder>("scan_library_folder", {
        path: root,
        maxDepth: LIBRARY_SCAN_DEPTH,
      });
      if (scanSweepRef.current !== sweep) return; // superseded — drop the write
      setScans((s) => ({ ...s, [root]: { status: "ok", tree } }));
    } catch (e) {
      if (scanSweepRef.current !== sweep) return; // superseded — drop the write
      // Fail loud: the root renders an inline error row, never a silent skip.
      setScans((s) => ({ ...s, [root]: { status: "error", message: formatError(e) } }));
    }
  }, []);

  const scanAll = useCallback(async (list: readonly string[]) => {
    const sweep = ++scanSweepRef.current;
    for (const root of list) {
      if (scanSweepRef.current !== sweep) return; // superseded by a newer sweep
      await scanOne(root);
    }
  }, [scanOne]);

  // App-boot scan (both views are keep-alive-mounted even while hidden).
  useEffect(() => {
    void scanAll(roots);
    // Mount-only by design — add/remove/rescan trigger their own scans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFolder = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string" || !picked) return;
    if (!roots.includes(picked)) {
      const next = [...roots, picked];
      setRoots(next);
      saveLibraryRoots(next);
    }
    void scanOne(picked); // new or re-picked — (re)scan just this root
  }, [roots, scanOne]);

  const removeRoot = useCallback((root: string) => {
    const name = root.split("/").pop() || root;
    // Forgets the root only — never touches the disk.
    if (!confirm(`Remove "${name}" from your library? The folder and its files stay on disk.`)) return;
    const next = roots.filter((r) => r !== root);
    setRoots(next);
    saveLibraryRoots(next);
    setScans((s) => {
      const { [root]: _dropped, ...rest } = s;
      return rest;
    });
  }, [roots]);

  const rescanAll = useCallback(() => {
    void scanAll(roots);
  }, [roots, scanAll]);

  const scanRoot = useCallback((root: string) => { void scanOne(root); }, [scanOne]);

  const scanning = roots.some((r) => scans[r]?.status === "loading");

  return {
    roots, scans, scanning,
    addFolder, removeRoot, rescanAll, scanRoot,
    requestThumb: requestThumbnail, invalidateThumb,
    posterVersions, bumpPoster, resetPoster,
  };
}
