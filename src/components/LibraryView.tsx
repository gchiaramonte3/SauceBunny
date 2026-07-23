import { useCallback, useEffect, useMemo, useState } from "react";
import { AmbientBackdrop } from "./AmbientBackdrop";
import { LibraryHero } from "./LibraryHero";
import { LibraryRow } from "./LibraryRow";
import { LibraryCard, type LibraryCardArt } from "./LibraryCard";
import { LibraryFolderCard } from "./LibraryFolderCard";
import { ThumbnailPicker } from "./ThumbnailPicker";
import { IconSearch } from "./Icons";
import type { RootScan } from "../hooks/use-library-scan";
import {
  chosenPosterFor,
  clearChosenPoster,
  countLibraryItems,
  formatBytes,
  formatModifiedDate,
  libraryPosterPaths,
  searchLibrary,
  setChosenPoster,
  type LibraryCrumb,
} from "../lib/library";
import { mediaKindOf } from "../lib/import-extensions";
import {
  formatTimeAgo,
  TRANSCRIPTS_CHANGED_EVENT,
} from "../lib/transcript-history";
import { loadTranscriptLibrary, type LibraryTranscript } from "../lib/transcript-library";
import { buildRecentIndex, transcriptArt } from "../lib/transcript-source-resolve";
import {
  hostnameOf,
  youTubeHeroThumbnailUrl,
  youTubeThumbnailUrl,
} from "../lib/validation";
import type { RecentSource } from "../lib/recent-sources";
import type { LibraryFolder, LibraryItem } from "../types";

type Props = {
  recentSources: RecentSource[];
  /** Routes to the same loadLocalPath flow as drag-drop/import. */
  onOpenLocalPath: (path: string) => void;
  /** "Review this clip": open the source and land in Review. */
  onReviewLocalPath: (path: string) => void;
  onReviewRecentSource: (r: RecentSource) => void;
  /** Same handler as the URL-bar history popover — no parallel load path. */
  onOpenRecentSource: (entry: RecentSource) => void;
  /** Opens a transcript (real or synthesized history entry) through the
   *  existing handler — follows along with the source when it's known. */
  onOpenTranscriptHistory: (entry: LibraryTranscript["entry"]) => void;
  /** The effective transcript library dir (defaults.transcriptLibrary) — the
   *  Transcribed shelf scans it so EVERY transcript on disk shows, not just the
   *  50 most recent the history caps at. */
  transcriptLibraryPath: string;
  /** Switches to the Clip view; true also focuses the URL field. */
  onSwitchToClip: () => void;
  /** A folder card / folder search-hit was opened → jump to the Library
   *  browser with that folder selected (one detail browser, not two). */
  onOpenFolder: (chain: LibraryCrumb[]) => void;
  /** Bumped by App when the nav logo/Home is pressed — clears Home's search. */
  homeResetSignal: number;
  /** True while Home is the active view. Threaded to the ambient backdrop so its
   *  cross-fade cycle pauses while Home is [hidden] (the view stays mounted). */
  homeVisible: boolean;
  // ── Shared scan state (useLibraryScan, owned by App) ──
  roots: string[];
  scans: Record<string, RootScan>;
  addFolder: () => Promise<void>;
  removeRoot: (root: string) => void;
  scanRoot: (root: string) => void;
  requestThumb: (path: string) => Promise<string | null>;
  invalidateThumb: (path: string) => void;
  posterVersions: Record<string, number>;
  bumpPoster: (path: string) => void;
  resetPoster: (path: string) => void;
};

/**
 * Home view — the landing page. A dark, Apple TV-style wall over the user's
 * added folders: hero over the most recent source, a featured-size Continue
 * shelf (recents), one shelf per root, and a Transcribed shelf. Its header is
 * just the search field. It no longer owns scan state
 * (that lifted to useLibraryScan in App, shared with the Library browser) and
 * no longer drills in place — opening a folder routes to the Library browser
 * via onOpenFolder. Only UI-local state (search + picker) lives here.
 */
export function LibraryView({
  recentSources, onOpenLocalPath, onOpenRecentSource, onOpenTranscriptHistory,
  onReviewLocalPath, onReviewRecentSource, transcriptLibraryPath,
  onSwitchToClip, onOpenFolder, homeResetSignal, homeVisible,
  roots, scans, addFolder, removeRoot, scanRoot,
  requestThumb, invalidateThumb, posterVersions, bumpPoster, resetPoster,
}: Props) {
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  // Bumped when Home becomes the active view so the Transcribed shelf
  // re-reads localStorage — new transcripts land while the user works in
  // Clip, and this view is keep-alive-mounted the whole time.
  const [historyTick, setHistoryTick] = useState(0);
  // "Set thumbnail…" picker target (null = closed).
  const [pickerPath, setPickerPath] = useState<string | null>(null);

  useEffect(() => {
    if (homeVisible) setHistoryTick((t) => t + 1);
  }, [homeVisible]);

  // Live refresh: transcript-history fires a same-window CustomEvent on every
  // write (the speakers-changed pattern), so the shelf updates even while
  // Home stays the active view. The homeVisible bump above remains as the
  // cheap catch-all for anything that slipped past the event.
  useEffect(() => {
    const onChange = () => setHistoryTick((t) => t + 1);
    window.addEventListener(TRANSCRIPTS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(TRANSCRIPTS_CHANGED_EVENT, onChange);
  }, []);

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

  // Nav logo / Home always returns to the top level (clears the search).
  useEffect(() => {
    if (homeResetSignal > 0) clearSearch();
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
  // Every transcript ON DISK, reconciled with history — not just the 50 the
  // localStorage history caps at. Re-scans when Home becomes active or a new
  // transcript lands (historyTick covers both, plus the initial mount).
  const [transcripts, setTranscripts] = useState<LibraryTranscript[]>([]);
  useEffect(() => {
    void historyTick; // the tick IS the trigger
    let alive = true;
    void loadTranscriptLibrary(transcriptLibraryPath).then((list) => {
      if (alive) setTranscripts(list);
    });
    return () => { alive = false; };
  }, [historyTick, transcriptLibraryPath]);
  // Continue shelf — the 8 most recent (the featured row stays a row, not an
  // archive; recents themselves are capped at 12 upstream).
  const continueRow = recentSources.slice(0, 8);
  // Slug index of recent sources, so a source-less transcript card can borrow a
  // poster from the source it was named after (KT-#776 transcript → KT-#776 web).
  const recentIndex = useMemo(() => buildRecentIndex(recentSources), [recentSources]);

  // ── Card builders (shared by shelves and the search grid) ─────────────
  const itemCard = (it: LibraryItem) => (
    <LibraryCard
      key={`${it.path}#${posterVersions[it.path] ?? 0}`}
      title={it.name}
      detail={[formatBytes(it.size_bytes), formatModifiedDate(it.modified_ms)]
        .filter(Boolean).join(" · ")}
      art={{ kind: "local", path: it.path, media: it.kind }}
      onOpen={() => onOpenLocalPath(it.path)}
      onReview={() => onReviewLocalPath(it.path)}
      onChoosePoster={setPickerPath}
      onResetPoster={resetPoster}
      requestThumb={requestThumb}
    />
  );

  const folderCard = (f: LibraryFolder, chain: LibraryCrumb[]) => (
    <LibraryFolderCard
      key={f.path}
      name={f.name}
      count={countLibraryItems(f)}
      posterPaths={libraryPosterPaths(f)}
      onOpen={() => { clearSearch(); onOpenFolder(chain); }}
      requestThumb={requestThumb}
    />
  );

  // Continue-row card — featured size (large landscape, the ref's front row).
  // Local entries route through the SAME requestThumb loader as the folder
  // rows (one representative-frame pipeline, no legacy path).
  const recentCard = (r: RecentSource) => (
    <LibraryCard
      key={`${r.value}#${posterVersions[r.value] ?? 0}`}
      title={r.title}
      detail={[r.kind === "url" ? hostnameOf(r.value) : "Local file",
        formatTimeAgo(r.lastOpenedAt)].join(" · ")}
      art={r.kind === "url"
        // Featured size shows 480px hqdefault soft — try maxres first, and the
        // card walks the list on 404 (maxres is missing on older/low-res
        // videos, same chain the hero uses).
        ? {
            kind: "remote",
            url: youTubeThumbnailUrl(r.value),
            urls: [youTubeHeroThumbnailUrl(r.value), youTubeThumbnailUrl(r.value)]
              .filter((u): u is string => u != null),
          }
        : { kind: "local", path: r.value, media: mediaKindOf(r.value) }}
      badge={r.kind === "url" ? "web" : undefined}
      large
      onOpen={() => onOpenRecentSource(r)}
      onReview={() => onReviewRecentSource(r)}
      onChoosePoster={setPickerPath}
      onResetPoster={resetPoster}
      requestThumb={requestThumb}
    />
  );

  const transcriptCard = (t: LibraryTranscript) => {
    // Re-associates a source-less transcript to a recent source by slug, so its
    // card shows a real poster instead of a glyph (also adds the webPosterFor
    // fallback the reader has, for non-YouTube web sources).
    const art: LibraryCardArt = transcriptArt(t, recentIndex);
    const detail = [
      t.hasDiarization ? "speakers" : null,
      formatTimeAgo(t.modifiedMs),
    ].filter(Boolean).join(" · ");
    return (
      <LibraryCard
        key={t.path}
        title={t.title}
        detail={detail}
        art={art}
        badge={t.format}
        onOpen={() => onOpenTranscriptHistory(t.entry)}
        requestThumb={requestThumb}
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
            <button type="button" className="btn btn-compact" onClick={() => scanRoot(root)}>
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

  return (
    // <main> = the Home view's single main landmark (the other views' roots are
    // [hidden] and out of the a11y tree while Home is active). tabIndex={-1}
    // makes .cp-lib a programmatic focus target for the view switch.
    <main
      className="cp-lib"
      tabIndex={-1}
      onKeyDown={(e) => {
        // Esc anywhere in Home clears an active search.
        if (e.key === "Escape" && query !== "") {
          e.stopPropagation();
          clearSearch();
        }
      }}
    >
      <div className="cp-lib-scroll">
      {/* Home's header is just the search field, right-aligned. Add Folder
          and rescan live in the Library browser (its tree footer). The hero
          pull-up only applies when the hero is actually rendered — the search
          branch flattens it so results never tuck under the chip. */}
      <header className={"cp-lib-head" + (searching ? " cp-lib-head-flat" : "")}>
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
      </header>

      {searching ? (
        <>
          {results.folders.length + results.items.length === 0 ? (
            <p className="cp-lib-note cp-lib-grid-note">No matches for “{needle.trim()}”.</p>
          ) : results.totalItems > results.items.length ? (
            <p className="cp-lib-note cp-lib-grid-note">
              Showing {results.items.length} of {results.totalItems} matches.
            </p>
          ) : null}
          <div role="list" aria-label="Search results" className="cp-lib-grid">
            {results.folders.map((hit) => folderCard(hit.folder, hit.chain))}
            {results.items.map(itemCard)}
          </div>
        </>
      ) : (
        <>
          <LibraryHero
            /* Key the hero on recentSources[0]'s poster version so a "Set
               thumbnail…" pick remounts it (its lazy hook already fired).
               Web/URL sources have no version bump → stable. */
            key={`hero#${recentSources[0] ? (posterVersions[recentSources[0].value] ?? 0) : 0}`}
            recent={recentSources[0] ?? null}
            onOpen={onOpenRecentSource}
            onAddFolder={() => void addFolder()}
            onPasteUrl={onSwitchToClip}
          />
          <div className="cp-lib-rows">
            {/* Ambient montage of already-cached posters — beneath the SHELVES
                only, never behind the hero (the hero owns its art and must
                dissolve into flat bg-0). aria-hidden + pointer-events none;
                pauses while Home isn't the active view. */}
            <AmbientBackdrop active={homeVisible} />
            {continueRow.length > 0 && (
              <LibraryRow title="Continue" count={continueRow.length}>
                {continueRow.map(recentCard)}
              </LibraryRow>
            )}
            {roots.map(rootRow)}
            {roots.length === 0 && recentSources.length > 0 && (
              <div className="cp-lib-invite">
                <p className="cp-lib-note">Add a folder to browse it here.</p>
                <button type="button" className="btn" onClick={() => void addFolder()}>
                  Choose a folder…
                </button>
              </div>
            )}
            {transcripts.length > 0 && (
              <LibraryRow title="Transcribed" count={transcripts.length}>
                {transcripts.map(transcriptCard)}
              </LibraryRow>
            )}
          </div>
        </>
      )}
      </div>

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
