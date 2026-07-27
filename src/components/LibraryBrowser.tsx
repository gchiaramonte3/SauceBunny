import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LibraryTree } from "./LibraryTree";
import { LibraryBrowserBar, type LibraryViewMode } from "./LibraryBrowserBar";
import { LibraryBrowserPane } from "./LibraryBrowserPane";
import { LibraryDetail } from "./LibraryDetail";
import { ThumbnailPicker } from "./ThumbnailPicker";
import type { RootScan } from "../hooks/use-library-scan";
import {
  chosenPosterFor, clearChosenPoster, collectLibraryItems, findLibraryFolder,
  setChosenPoster, sortLibraryItems, formatBytes,
  type LibraryCrumb, type LibraryKindFilter, type LibrarySortDir, type LibrarySortKey,
} from "../lib/library";
import { loadJson, saveJson } from "../lib/storage";
import type { TranscriptHistoryEntry } from "../lib/transcript-history";
import type { LibraryFolder, LibraryItem } from "../types";

type BrowserPrefs = {
  view: LibraryViewMode; sort: LibrarySortKey; dir: LibrarySortDir; kind: LibraryKindFilter;
};
const BROWSER_KEY = "saucebunny.libraryBrowser";

function normalizePrefs(raw: unknown): BrowserPrefs {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};
  const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
    opts.includes(v as T) ? (v as T) : d;
  return {
    view: oneOf(r.view, ["grid", "list"] as const, "grid"),
    sort: oneOf(r.sort, ["name", "date", "size"] as const, "name"),
    dir: oneOf(r.dir, ["asc", "desc"] as const, "asc"),
    kind: oneOf(r.kind, ["all", "video", "audio"] as const, "all"),
  };
}

type Props = {
  roots: string[];
  scans: Record<string, RootScan>;
  scanning: boolean;
  addFolder: () => Promise<void>;
  rescanAll: () => void;
  requestThumb: (path: string) => Promise<string | null>;
  invalidateThumb: (path: string) => void;
  posterVersions: Record<string, number>;
  bumpPoster: (path: string) => void;
  resetPoster: (path: string) => void;
  /** Home drill-in handoff — the folder chain to select (null = "All"). */
  selection: LibraryCrumb[] | null;
  /** Bumped on each handoff so the same chain re-applies. */
  selectionTick: number;
  onOpenLocalPath: (path: string) => void;
  /** "Review this clip": open the source and land in Review. */
  onReviewLocalPath?: (path: string) => void;
  onOpenTranscriptHistory: (entry: TranscriptHistoryEntry) => void;
};

/**
 * The Library view — a Plex/Finder-hybrid detail browser over the same scanned
 * roots as Home. Three regions: a library panel (LibraryTree — header, kind
 * chips, folder tree), a main pane with a breadcrumb/search/sort/view bar over
 * a grid or list of the selection's media, and a detail panel (LibraryDetail)
 * on selection. Scan state is shared from useLibraryScan, so switching to/from
 * Home never rescans.
 */
/**
 * Most files the browse pane will mount at once.
 *
 * Not a performance guess: each card carries an IntersectionObserver and, for
 * local video, two window listeners for the hover-frame cycle, plus a
 * focusable ⋯ button. The number matches the cap `searchLibrary` already
 * applies for the same reason.
 */
const BROWSE_CAP = 300;

export function LibraryBrowser({
  roots, scans, scanning, addFolder, rescanAll, requestThumb, invalidateThumb,
  posterVersions, bumpPoster, resetPoster, selection, selectionTick,
  onOpenLocalPath, onReviewLocalPath, onOpenTranscriptHistory,
}: Props) {
  const [selected, setSelected] = useState<LibraryCrumb[] | null>(selection);
  const [prefs, setPrefs] = useState<BrowserPrefs>(() => normalizePrefs(loadJson<unknown>(BROWSER_KEY, {})));
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [detailItem, setDetailItem] = useState<LibraryItem | null>(null);
  const [pickerPath, setPickerPath] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);

  useEffect(() => { saveJson(BROWSER_KEY, prefs); }, [prefs]);
  const patchPrefs = useCallback((p: Partial<BrowserPrefs>) => setPrefs((prev) => ({ ...prev, ...p })), []);

  // The detail panel is non-modal, so opening/closing it must hand keyboard
  // focus back to the card/row that opened it — otherwise a focus-in-panel
  // dismiss (Esc or ✕) drops focus to <body> and Tab restarts at the top.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const openDetail = useCallback((item: LibraryItem) => {
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    setDetailItem(item);
  }, []);
  const closeDetail = useCallback(() => {
    setDetailItem(null);
    const el = lastFocusRef.current;
    // rAF defers focus() until after React commits the panel unmount.
    if (el && document.contains(el)) requestAnimationFrame(() => el.focus());
  }, []);

  // Handoff from Home: apply the requested selection and reset the scoped view.
  useEffect(() => {
    setSelected(selection);
    setDetailItem(null);
    setQuery("");
    setNeedle("");
    // Re-apply on every handoff even if the chain object is identical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionTick]);

  // Scoped search — debounced 150ms, instant clear (mirrors Home).
  useEffect(() => {
    if (query === "") { setNeedle(""); return; }
    const id = window.setTimeout(() => setNeedle(query), 150);
    return () => window.clearTimeout(id);
  }, [query]);

  const trees = useMemo<LibraryFolder[]>(
    () => roots
      .map((r) => scans[r])
      .filter((s): s is Extract<RootScan, { status: "ok" }> => s?.status === "ok")
      .map((s) => s.tree),
    [roots, scans],
  );
  const selectedNode = useMemo(
    () => (selected ? findLibraryFolder(trees, selected[selected.length - 1].path) : null),
    [trees, selected],
  );

  // Self-heal a stale selection (root removed / renamed / errored), waiting out
  // in-flight scans so a rescan doesn't bounce a valid selection to "All".
  useEffect(() => {
    if (!selected) return;
    const rootPath = selected[0]?.path ?? "";
    const rootScan = scans[rootPath];
    if (!rootScan || rootScan.status === "loading") {
      if (!roots.includes(rootPath)) setSelected(null);
      return;
    }
    if (rootScan.status === "error" || !findLibraryFolder(trees, selected[selected.length - 1].path)) setSelected(null);
  }, [selected, scans, roots, trees]);

  // Drop the detail selection if its file vanished from the trees (rescan/remove).
  const allPaths = useMemo(() => {
    const s = new Set<string>();
    for (const t of trees) for (const it of collectLibraryItems(t)) s.add(it.path);
    return s;
  }, [trees]);
  useEffect(() => {
    if (detailItem && !allPaths.has(detailItem.path)) setDetailItem(null);
  }, [allPaths, detailItem]);

  const items = useMemo(() => {
    // Only the real "All" view (selected === null) aggregates every root. A
    // concrete selection whose node is momentarily absent (its root mid-rescan)
    // shows nothing until the scan lands — never another folder's media.
    const base = selected
      ? (selectedNode ? collectLibraryItems(selectedNode) : [])
      : trees.flatMap(collectLibraryItems);
    const byKind = prefs.kind === "all" ? base : base.filter((i) => i.kind === prefs.kind);
    const q = needle.trim().toLowerCase();
    const bySearch = q ? byKind.filter((i) => i.name.toLowerCase().includes(q)) : byKind;
    return sortLibraryItems(bySearch, prefs.sort, prefs.dir);
  }, [selected, selectedNode, trees, prefs, needle]);

  // The "All" view aggregates every root with no ceiling, and every card is a
  // real DOM node with its own IntersectionObserver and two window listeners.
  // A 2000-file drive mounted 2000 of them and put 4000 controls in the tab
  // order. Home's search already reasoned about exactly this and capped at 120
  // with a "showing N of M" note (searchLibrary in lib/library.ts); this is the
  // same answer, in the constitution's spirit — a cap and an honest count, not
  // a virtualization dependency.
  const shown = useMemo(() => items.slice(0, BROWSE_CAP), [items]);
  const overflow = items.length - shown.length;
  // Finder's status bar. Counts the whole filtered set, not the capped slice,
  // so the number answers "how much is in here" rather than "how much did we
  // draw".
  const totalBytes = useMemo(() => items.reduce((n, i) => n + i.size_bytes, 0), [items]);

  const emptyText = needle.trim()
    ? `No matches for “${needle.trim()}”.`
    // Saying "No playable media here." while the walk is still running is
    // simply false, and on a cold NAS or an external drive it is the first
    // sentence a new user reads. Home already gets this right; the browser
    // never got the same treatment.
    : scanning
      ? "Scanning…"
      : "No playable media here.";

  // Rootless library — one centered line + the primary action. Nothing else
  // (no panel, no bar): there is nothing to browse, filter, or sort yet.
  if (roots.length === 0) {
    return (
      <div className="cp-lib-browse">
        <div className="cp-lib-browse-zero">
          <p>Add a folder to build your library.</p>
          <button type="button" className="btn btn-primary" onClick={() => void addFolder()}>
            Add folder
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="cp-lib-browse"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (detailItem) { e.stopPropagation(); closeDetail(); }
        else if (query !== "") { e.stopPropagation(); setQuery(""); setNeedle(""); }
      }}
    >
      {treeOpen && (
        <LibraryTree
          trees={trees}
          selection={selected}
          onSelect={(chain) => { setSelected(chain); setDetailItem(null); }}
          kind={prefs.kind}
          onKind={(kind) => patchPrefs({ kind })}
          onCollapse={() => setTreeOpen(false)}
          addFolder={addFolder}
          rescanAll={rescanAll}
          scanning={scanning}
        />
      )}
      <div className="cp-lib-main">
        <LibraryBrowserBar
          chain={selected}
          onCrumb={(chain) => { setSelected(chain); setDetailItem(null); }}
          query={query}
          onQuery={setQuery}
          sort={prefs.sort}
          dir={prefs.dir}
          view={prefs.view}
          onPrefs={patchPrefs}
          treeOpen={treeOpen}
          onShowTree={() => setTreeOpen(true)}
        />
        <div className="cp-lib-browse-body">
          <LibraryBrowserPane
            items={shown}
            sort={prefs.sort}
            dir={prefs.dir}
            /* Clicking the active column flips it; a different column starts
               fresh rather than inheriting the last one's direction. */
            onSort={(key) => patchPrefs(
              key === prefs.sort
                ? { dir: prefs.dir === "asc" ? "desc" : "asc" }
                : { sort: key, dir: key === "name" ? "asc" : "desc" },
            )}
            view={prefs.view}
            selectedPath={detailItem?.path ?? null}
            posterVersions={posterVersions}
            requestThumb={requestThumb}
            onOpen={onOpenLocalPath}
            onReview={onReviewLocalPath}
            onSelectItem={openDetail}
            onChoosePoster={setPickerPath}
            onResetPoster={resetPoster}
            onClearSelection={() => setDetailItem(null)}
            emptyText={emptyText}
          />
          {detailItem && (
            <LibraryDetail
              key={`${detailItem.path}#${posterVersions[detailItem.path] ?? 0}`}
              item={detailItem}
              requestThumb={requestThumb}
              onOpenInClip={() => onOpenLocalPath(detailItem.path)}
              onChoosePoster={setPickerPath}
              onOpenTranscript={onOpenTranscriptHistory}
              onClose={closeDetail}
            />
          )}
        </div>
        {/* Finder's status bar: pinned to the bottom of the window, OUTSIDE
            the scroller, so it stays put while the wall scrolls. Says what is
            in the folder, and — when the render cap bites — says so plainly
            rather than letting someone believe they are seeing everything.
            Hidden when there is nothing, so the empty and scanning states get
            the pane to themselves. */}
        {items.length > 0 && (
          <div className="cp-lib-statusbar">
            {items.length} item{items.length === 1 ? "" : "s"}
            {totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ""}
            {overflow > 0 ? ` · showing ${shown.length}, ${overflow} more not shown` : ""}
          </div>
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
    </div>
  );
}
