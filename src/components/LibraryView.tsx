import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { LibraryHero } from "./LibraryHero";
import { LibraryRow } from "./LibraryRow";
import { LibraryCard, type LibraryCardArt } from "./LibraryCard";
import { LibraryFolderCard } from "./LibraryFolderCard";
import { ThumbnailPicker } from "./ThumbnailPicker";
import { IconPlus, IconRefresh, IconSearch } from "./Icons";
import {
  LIBRARY_SCAN_DEPTH,
  chosenPosterFor,
  clearChosenPoster,
  countLibraryItems,
  formatBytes,
  formatModifiedDate,
  libraryPosterPaths,
  loadLibraryRoots,
  resolveLibraryChain,
  saveLibraryRoots,
  searchLibrary,
  setChosenPoster,
  type LibraryCrumb,
} from "../lib/library";
import { formatError } from "../lib/error-format";
import { extractPosterBlob } from "../lib/mediabunny-helpers";
import { AUDIO_EXTENSIONS, fileExtension } from "../lib/import-extensions";
import {
  getHistory as getTranscriptHistory,
  formatTimeAgo,
  type TranscriptHistoryEntry,
} from "../lib/transcript-history";
import { hostnameOf, youTubeThumbnailUrl } from "../lib/validation";
import type { RecentSource } from "../lib/recent-sources";
import type { LibraryFolder, LibraryItem } from "../types";

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
/** path → decode generation. invalidateThumb bumps it so a decode already in
 *  flight when the user picks a new poster discards its now-stale result
 *  instead of racing the fresh one into the cache. */
const thumbGen = new Map<string, number>();

function rememberThumb(path: string, url: string): void {
  // Overwriting an existing entry (e.g. a duplicate same-path job) must release
  // the prior blob, not just the LRU-evicted ones, or the old decode leaks.
  const prior = thumbCache.get(path);
  if (prior && prior !== url && prior.startsWith("blob:")) URL.revokeObjectURL(prior);
  thumbCache.set(path, url);
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
 * builders below), which re-runs its lazy-thumbnail hook against this cleared
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
  // Supersede any decode already in flight for this path (the ffmpeg fallback
  // can take a while): the running job will see the bumped generation and drop
  // its stale result rather than overwriting the cache with the old poster.
  thumbGen.set(path, (thumbGen.get(path) ?? 0) + 1);
}

/** Cached + de-duped + concurrency-capped poster fetch for one video path. */
function requestThumbnail(path: string): Promise<string | null> {
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
    if (thumbRunning >= THUMB_CONCURRENCY) {
      await new Promise<void>((release) => thumbWaiters.push(release));
    }
    thumbRunning++;
    try {
      const url = await loadThumbnail(path);
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
      // Runs on BOTH resolve and the caught reject, so the slot is always freed
      // and the next queued waiter always kicked — a failed decode never leaks a
      // concurrency slot.
      thumbRunning--;
      thumbWaiters.shift()?.();
      // Only clear the pending slot if we still own it. If a pick superseded us,
      // a newer job now holds thumbPending — deleting it would defeat dedup.
      if (current()) thumbPending.delete(path);
    }
  })();
  thumbPending.set(path, job);
  return job;
}

/** Recents/transcripts don't carry a media kind — infer from the extension. */
function mediaKindOf(path: string): "video" | "audio" {
  return AUDIO_EXTENSIONS.includes(fileExtension(path)) ? "audio" : "video";
}

type RootScan =
  | { status: "loading" }
  | { status: "ok"; tree: LibraryFolder }
  | { status: "error"; message: string };

type Props = {
  recentSources: RecentSource[];
  /** Routes to the same loadLocalPath flow as drag-drop/import. */
  onOpenLocalPath: (path: string) => void;
  /** Same handler as the URL-bar history popover — no parallel load path. */
  onOpenRecentSource: (entry: RecentSource) => void;
  /** Loads a past transcript's source through the existing history handler. */
  onOpenTranscriptHistory: (entry: TranscriptHistoryEntry) => void;
  /** Switches to the Clip view; true also focuses the URL field. */
  onSwitchToClip: (focusUrl?: boolean) => void;
  /** Bumped by App when the nav logo/Home is pressed — always returns the
   *  Library to its top level (clears drill-in + search). */
  homeResetSignal: number;
};

/**
 * Home view — the Library. A dark, Netflix-style browser over user-added
 * folders: hero over the most recent source, a Continue shelf (recents),
 * one shelf per root (scan_library_folder), and a Transcripts shelf.
 * Owns ALL library state (roots, scans, search, drill-in) — App only
 * supplies the open handlers, so no scan state leaks up. Scans run on
 * mount and on explicit actions (add root, retry, rescan) — never on a
 * timer.
 */
export function LibraryView({
  recentSources, onOpenLocalPath, onOpenRecentSource, onOpenTranscriptHistory,
  onSwitchToClip, homeResetSignal,
}: Props) {
  const [roots, setRoots] = useState<string[]>(() => loadLibraryRoots());
  const [scans, setScans] = useState<Record<string, RootScan>>({});
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [drill, setDrill] = useState<LibraryCrumb[] | null>(null);
  // Bumped on rescan so the Transcripts shelf re-reads localStorage.
  const [historyTick, setHistoryTick] = useState(0);
  // "Set thumbnail…" picker target (null = closed) + a per-path poster version.
  // Bumping a path's version changes the matching card's React key, remounting
  // it so its lazy-thumbnail hook re-requests the (invalidated) poster.
  const [pickerPath, setPickerPath] = useState<string | null>(null);
  const [posterVersions, setPosterVersions] = useState<Record<string, number>>({});
  const bumpPoster = useCallback(
    (path: string) => setPosterVersions((v) => ({ ...v, [path]: (v[path] ?? 0) + 1 })),
    [],
  );
  // Menu "Reset thumbnail" — clear the chosen time, bust the cache (race-guard
  // + blob revoke), and remount the card via its poster-version key so it
  // re-requests the auto/representative frame. Same effect as the picker's
  // "Reset to auto", reachable without opening the picker.
  const resetPoster = useCallback((path: string) => {
    clearChosenPoster(path);
    invalidateThumb(path);
    bumpPoster(path);
  }, [bumpPoster]);
  const scanSweepRef = useRef(0);

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

  // App-boot scan (the view is keep-alive-mounted even while hidden).
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
    setDrill((d) => (d && d[0]?.path === root ? null : d));
  }, [roots]);

  const rescanAll = useCallback(() => {
    setHistoryTick((t) => t + 1); // Transcripts shelf re-reads history too
    void scanAll(roots);
  }, [roots, scanAll]);

  // ── Search: client-side, case-insensitive, debounced 150ms ────────────
  useEffect(() => {
    if (query === "") { setNeedle(""); return; } // clearing is instant (Esc)
    const id = window.setTimeout(() => setNeedle(query), 150);
    return () => window.clearTimeout(id);
  }, [query]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setNeedle("");
  }, []);

  // Nav logo / Home always returns to the top level.
  useEffect(() => {
    if (homeResetSignal > 0) {
      setDrill(null);
      clearSearch();
    }
  }, [homeResetSignal, clearSearch]);

  const trees = useMemo(
    () => roots
      .map((r) => scans[r])
      .filter((s): s is Extract<RootScan, { status: "ok" }> => s?.status === "ok")
      .map((s) => s.tree),
    [roots, scans],
  );
  const results = useMemo(() => searchLibrary(trees, needle), [trees, needle]);
  const searching = needle.trim() !== "";
  const transcripts = useMemo(() => getTranscriptHistory(), [historyTick]);
  const scanning = roots.some((r) => scans[r]?.status === "loading");

  // Drill-in resolves against the freshest trees; a settled rescan that no
  // longer contains the chain (or a failed/forgotten root) resets to top.
  // In-flight scans are waited out so a rescan doesn't bounce you home.
  const drilledNode = drill ? resolveLibraryChain(trees, drill) : null;
  useEffect(() => {
    if (!drill) return;
    const rootPath = drill[0]?.path ?? "";
    const rootScan = scans[rootPath];
    if (!rootScan || rootScan.status === "loading") {
      if (!roots.includes(rootPath)) setDrill(null);
      return;
    }
    if (rootScan.status === "error" || !resolveLibraryChain(trees, drill)) setDrill(null);
  }, [drill, scans, roots, trees]);

  // ── Card builders (shared by shelves, drill pages, and the search grid) ─
  const itemCard = (it: LibraryItem) => (
    <LibraryCard
      key={`${it.path}#${posterVersions[it.path] ?? 0}`}
      title={it.name}
      detail={[formatBytes(it.size_bytes), formatModifiedDate(it.modified_ms)]
        .filter(Boolean).join(" · ")}
      art={{ kind: "local", path: it.path, media: it.kind }}
      onOpen={() => onOpenLocalPath(it.path)}
      onChoosePoster={setPickerPath}
      onResetPoster={resetPoster}
      requestThumb={requestThumbnail}
    />
  );

  const folderCard = (f: LibraryFolder, chain: LibraryCrumb[]) => (
    <LibraryFolderCard
      key={f.path}
      name={f.name}
      count={countLibraryItems(f)}
      posterPaths={libraryPosterPaths(f)}
      onOpen={() => { clearSearch(); setDrill(chain); }}
      requestThumb={requestThumbnail}
    />
  );

  const recentCard = (r: RecentSource) => (
    <LibraryCard
      key={`${r.value}#${posterVersions[r.value] ?? 0}`}
      title={r.title}
      detail={[r.kind === "url" ? hostnameOf(r.value) : "Local file",
        formatTimeAgo(r.lastOpenedAt)].join(" · ")}
      art={r.kind === "url"
        ? { kind: "remote", url: youTubeThumbnailUrl(r.value) }
        : { kind: "local", path: r.value, media: mediaKindOf(r.value) }}
      badge={r.kind === "url" ? "web" : undefined}
      onOpen={() => onOpenRecentSource(r)}
      onChoosePoster={setPickerPath}
      onResetPoster={resetPoster}
      requestThumb={requestThumbnail}
    />
  );

  const transcriptCard = (t: TranscriptHistoryEntry) => {
    const art: LibraryCardArt = t.sourcePath
      ? { kind: "local", path: t.sourcePath, media: mediaKindOf(t.sourcePath) }
      : { kind: "remote", url: t.sourceUrl ? youTubeThumbnailUrl(t.sourceUrl) : null };
    return (
      <LibraryCard
        key={t.id}
        title={t.title}
        detail={`${t.origin === "unknown" ? "imported" : t.origin} · ${formatTimeAgo(t.lastOpenedAt)}`}
        art={art}
        badge="srt"
        onOpen={() => onOpenTranscriptHistory(t)}
        requestThumb={requestThumbnail}
      />
    );
  };

  // One shelf per root — loading / error / empty states render inline in
  // the same header frame so a bad root is loud but not layout-breaking.
  const rootRow = (root: string) => {
    const scan = scans[root];
    const label = root.split("/").pop() || root;
    const removeBtn = (
      <button
        type="button"
        className="cp-lib-row-remove"
        title={`Remove ${label} from library`}
        aria-label={`Remove ${label} from library`}
        onClick={() => removeRoot(root)}
      >
        ×
      </button>
    );
    if (!scan || scan.status === "loading") {
      return (
        <section key={root} className="cp-lib-row">
          <div className="cp-lib-row-head"><h2 className="cp-lib-row-title">{label}</h2></div>
          <p className="cp-lib-note">Scanning…</p>
        </section>
      );
    }
    if (scan.status === "error") {
      return (
        <section key={root} className="cp-lib-row">
          <div className="cp-lib-row-head">
            <h2 className="cp-lib-row-title">{label}</h2>
            {removeBtn}
          </div>
          <div className="cp-lib-error" role="alert">
            <span className="cp-lib-error-msg">{scan.message}</span>
            <button type="button" className="btn btn-compact" onClick={() => void scanOne(root)}>
              Retry
            </button>
          </div>
        </section>
      );
    }
    const tree = scan.tree;
    if (tree.folders.length === 0 && tree.items.length === 0) {
      return (
        <section key={root} className="cp-lib-row">
          <div className="cp-lib-row-head">
            <h2 className="cp-lib-row-title">{tree.name}</h2>
            {removeBtn}
          </div>
          <p className="cp-lib-note">No playable media in this folder.</p>
        </section>
      );
    }
    const rootCrumb: LibraryCrumb = { name: tree.name, path: tree.path };
    return (
      <LibraryRow
        key={root}
        title={tree.name}
        count={countLibraryItems(tree)}
        onRemove={() => removeRoot(root)}
        removeLabel={`Remove ${tree.name} from library`}
      >
        {tree.folders.map((f) => folderCard(f, [rootCrumb, { name: f.name, path: f.path }]))}
        {tree.items.map(itemCard)}
      </LibraryRow>
    );
  };

  // Drilled into a folder: its own loose files first, then one shelf per
  // subfolder (each showing that subfolder's collections + files) — "that
  // folder's rows". Deeper folders keep drilling via their collection cards.
  const drilledRows = (node: LibraryFolder, chain: LibraryCrumb[]) => (
    <>
      {node.items.length > 0 && (
        <LibraryRow title={node.name} count={node.items.length}>
          {node.items.map(itemCard)}
        </LibraryRow>
      )}
      {node.folders.map((g) => {
        const gChain = [...chain, { name: g.name, path: g.path }];
        return (
          <LibraryRow key={g.path} title={g.name} count={countLibraryItems(g)}>
            {g.folders.map((h) => folderCard(h, [...gChain, { name: h.name, path: h.path }]))}
            {g.items.map(itemCard)}
          </LibraryRow>
        );
      })}
      {node.items.length === 0 && node.folders.length === 0 && (
        <p className="cp-lib-note">This folder is empty.</p>
      )}
    </>
  );

  return (
    // <main> = the Home view's single main landmark (the Clip view's <main> is
    // [hidden] and out of the a11y tree while Home is active). The header nests
    // inside it, so cp-lib-head is a section header, not a second top-level
    // banner. tabIndex={-1} makes .cp-lib a programmatic focus target for the
    // view switch (a sibling owns that focus move) without entering tab order.
    <main
      className="cp-lib"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Esc anywhere in the Library clears an active search.
        if (e.key === "Escape" && query !== "") {
          e.stopPropagation();
          clearSearch();
        }
      }}
    >
      <header className="cp-lib-head">
        <h1 className="cp-lib-title">Library</h1>
        <div className="cp-lib-search">
          <IconSearch size={13} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library"
            aria-label="Search library"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query !== "" && (
            <button
              type="button"
              className="cp-lib-search-clear"
              aria-label="Clear search"
              onClick={clearSearch}
            >
              ×
            </button>
          )}
        </div>
        <button type="button" className="btn" onClick={() => void addFolder()}>
          <IconPlus size={13} /> Add Folder
        </button>
        <button
          type="button"
          className="btn-icon cp-lib-rescan"
          title="Rescan library"
          aria-label="Rescan library"
          onClick={rescanAll}
          disabled={scanning}
        >
          <IconRefresh size={14} />
        </button>
      </header>

      {searching ? (
        <>
          {results.folders.length + results.items.length === 0 ? (
            <p className="cp-lib-note cp-lib-grid-note">No matches for “{needle.trim()}”.</p>
          ) : results.totalItems > results.items.length ? (
            <p className="cp-lib-note cp-lib-grid-note">
              Showing {results.items.length} of {results.totalItems} matching files — refine your search.
            </p>
          ) : null}
          <div role="list" aria-label="Search results" className="cp-lib-grid">
            {results.folders.map((hit) => folderCard(hit.folder, hit.chain))}
            {results.items.map(itemCard)}
          </div>
        </>
      ) : drill ? (
        <>
          <nav className="cp-lib-crumbs" aria-label="Library location">
            <button type="button" onClick={() => setDrill(null)}>Library</button>
            {drill.map((c, i) => (
              <Fragment key={c.path}>
                <span className="sep" aria-hidden="true">/</span>
                {i === drill.length - 1 ? (
                  <span className="cur" aria-current="page">{c.name}</span>
                ) : (
                  <button type="button" onClick={() => setDrill(drill.slice(0, i + 1))}>
                    {c.name}
                  </button>
                )}
              </Fragment>
            ))}
          </nav>
          <div className="cp-lib-rows">
            {drilledNode
              ? drilledRows(drilledNode, drill)
              : <p className="cp-lib-note">Scanning…</p>}
          </div>
        </>
      ) : (
        <>
          <LibraryHero
            /* The hero backdrop is recentSources[0]'s poster; without keying it
               on that source's poster version, a "Set thumbnail…" pick updates
               the Continue card but leaves the hero on the old frame (its lazy
               hook already fired and won't re-request). Keying remounts only the
               hero for the picked path, re-running its load against the freshly
               invalidated cache. Web/URL sources have no version bump → stable. */
            key={`hero#${recentSources[0] ? (posterVersions[recentSources[0].value] ?? 0) : 0}`}
            recent={recentSources[0] ?? null}
            onOpen={onOpenRecentSource}
            onAddFolder={() => void addFolder()}
            onPasteUrl={() => onSwitchToClip(true)}
            requestThumb={requestThumbnail}
          />
          <div className="cp-lib-rows">
            {recentSources.length > 0 && (
              <LibraryRow title="Continue" count={recentSources.length}>
                {recentSources.map(recentCard)}
              </LibraryRow>
            )}
            {roots.map(rootRow)}
            {roots.length === 0 && recentSources.length > 0 && (
              <div className="cp-lib-invite">
                <p className="cp-lib-note">Add a folder to browse your footage as shelves here.</p>
                <button type="button" className="btn" onClick={() => void addFolder()}>
                  Choose a folder…
                </button>
              </div>
            )}
            {transcripts.length > 0 && (
              <LibraryRow title="Transcripts" count={transcripts.length}>
                {transcripts.map(transcriptCard)}
              </LibraryRow>
            )}
          </div>
        </>
      )}

      {pickerPath && (
        <ThumbnailPicker
          path={pickerPath}
          hasChosen={chosenPosterFor(pickerPath) != null}
          onPick={(seconds) => {
            setChosenPoster(pickerPath, seconds);
            invalidateThumb(pickerPath);
            bumpPoster(pickerPath);
            setPickerPath(null);
          }}
          onResetAuto={() => {
            clearChosenPoster(pickerPath);
            invalidateThumb(pickerPath);
            bumpPoster(pickerPath);
            setPickerPath(null);
          }}
          onClose={() => setPickerPath(null)}
        />
      )}
    </main>
  );
}
