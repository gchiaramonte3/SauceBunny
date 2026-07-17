import { useCallback, useEffect, useMemo, useState } from "react";
import { AmbientBackdrop } from "./AmbientBackdrop";
import { LibraryHero } from "./LibraryHero";
import { LibraryRow } from "./LibraryRow";
import { LibraryCard, type LibraryCardArt } from "./LibraryCard";
import { LibraryFolderCard } from "./LibraryFolderCard";
import { ThumbnailPicker } from "./ThumbnailPicker";
import { IconPlus, IconRefresh, IconSearch } from "./Icons";
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
import { AUDIO_EXTENSIONS, fileExtension } from "../lib/import-extensions";
import {
  getHistory as getTranscriptHistory,
  formatTimeAgo,
  type TranscriptHistoryEntry,
} from "../lib/transcript-history";
import { hostnameOf, youTubeThumbnailUrl } from "../lib/validation";
import type { RecentSource } from "../lib/recent-sources";
import type { LibraryFolder, LibraryItem } from "../types";

/** Recents/transcripts don't carry a media kind — infer from the extension. */
function mediaKindOf(path: string): "video" | "audio" {
  return AUDIO_EXTENSIONS.includes(fileExtension(path)) ? "audio" : "video";
}

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
  scanning: boolean;
  addFolder: () => Promise<void>;
  removeRoot: (root: string) => void;
  rescanAll: () => void;
  scanRoot: (root: string) => void;
  requestThumb: (path: string) => Promise<string | null>;
  invalidateThumb: (path: string) => void;
  posterVersions: Record<string, number>;
  bumpPoster: (path: string) => void;
  resetPoster: (path: string) => void;
};

/**
 * Home view — the landing page. A dark, Netflix-style wall over the user's
 * added folders: hero over the most recent source, a Continue shelf (recents),
 * one shelf per root, and a Transcripts shelf. It no longer owns scan state
 * (that lifted to useLibraryScan in App, shared with the Library browser) and
 * no longer drills in place — opening a folder routes to the Library browser
 * via onOpenFolder. Only UI-local state (search + picker) lives here.
 */
export function LibraryView({
  recentSources, onOpenLocalPath, onOpenRecentSource, onOpenTranscriptHistory,
  onSwitchToClip, onOpenFolder, homeResetSignal, homeVisible,
  roots, scans, scanning, addFolder, removeRoot, rescanAll, scanRoot,
  requestThumb, invalidateThumb, posterVersions, bumpPoster, resetPoster,
}: Props) {
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  // Bumped on rescan so the Transcripts shelf re-reads localStorage.
  const [historyTick, setHistoryTick] = useState(0);
  // "Set thumbnail…" picker target (null = closed).
  const [pickerPath, setPickerPath] = useState<string | null>(null);

  const rescanHome = useCallback(() => {
    setHistoryTick((t) => t + 1); // Transcripts shelf re-reads history too
    rescanAll();
  }, [rescanAll]);

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
  const transcripts = useMemo(() => getTranscriptHistory(), [historyTick]);

  // ── Card builders (shared by shelves and the search grid) ─────────────
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
      requestThumb={requestThumb}
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
      {/* Behind everything: a slow montage of the user's own already-cached
          posters. Rendered first, kept below the content layer by z-index (the
          .cp-lib-scroll wrapper sits above it). aria-hidden + pointer-events
          none — purely atmospheric. Pauses while Home isn't the active view. */}
      <AmbientBackdrop active={homeVisible} />
      <div className="cp-lib-scroll">
      <header className="cp-lib-head">
        <h1 className="cp-lib-title">Home</h1>
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
          onClick={rescanHome}
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
            onPasteUrl={() => onSwitchToClip(true)}
            requestThumb={requestThumb}
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
                <p className="cp-lib-note">Add a folder to browse it here.</p>
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
