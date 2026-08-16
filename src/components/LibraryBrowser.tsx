import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LibraryTree } from "./LibraryTree";
import { LibraryBrowserBar, type LibraryViewMode } from "./LibraryBrowserBar";
import { LibraryBrowserPane } from "./LibraryBrowserPane";
import { LibrarySelectionBar } from "./LibrarySelectionBar";
import { useFinderTags } from "../hooks/use-finder-tags";
import { CachedWebPane } from "./CachedWebPane";
import { marqueeSelection } from "../lib/marquee";
import { RenameDialog } from "./RenameDialog";
import { LibraryQuickLook } from "./LibraryQuickLook";
import { applyRenamePlan } from "../lib/rename-apply";
import {
  clickSelect, contextMenuSelect, EMPTY_SELECTION, pruneSelection, selectAll, selectedInOrder,
  type SelectionState,
} from "../lib/library-selection";
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
  removeRoot: (root: string) => void;
  /** Re-open a cached web source. The URL goes back through the normal fetch
   *  path, which finds the warm cache and skips extraction. */
  onOpenWebUrl: (url: string) => void;
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
  /** Transcribe a set of files in the background. Absent in contexts with no
   *  transcription settings resolved (the panel window). */
  onBatchTranscribe?: (files: { path: string; name: string }[]) => void;
  /** Live batch status for the bar, when a run is going. */
  batchLine?: string | null;
  onBatchCancel?: () => void;
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
  roots, scans, scanning, addFolder, removeRoot, onOpenWebUrl, rescanAll, requestThumb, invalidateThumb,
  posterVersions, bumpPoster, resetPoster, selection, selectionTick,
  onOpenLocalPath, onReviewLocalPath, onOpenTranscriptHistory,
  onBatchTranscribe, batchLine, onBatchCancel,
}: Props) {
  const [selected, setSelected] = useState<LibraryCrumb[] | null>(selection);
  /** The cached-web shelf replaces the file pane when chosen. Separate state
   *  rather than a third value of `selected`, because every folder verb below
   *  is typed against a crumb chain and would need widening for a view that
   *  has no folder at all. */
  const [webView, setWebView] = useState(false);
  const [prefs, setPrefs] = useState<BrowserPrefs>(() => normalizePrefs(loadJson<unknown>(BROWSER_KEY, {})));
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [detailItem, setDetailItem] = useState<LibraryItem | null>(null);
  /** Multi-selection for batch actions. The DETAIL panel still follows a single
   *  item (detailItem); this is the set the toolbar acts on. */
  const [sel, setSel] = useState<SelectionState>(EMPTY_SELECTION);
  /** The selection when the current band started; null when no drag is live. */
  const dragBaseRef = useRef<ReadonlySet<string> | null>(null);
  /** Files the rename dialog is open for, or null. */
  const [renaming, setRenaming] = useState<LibraryItem[] | null>(null);
  /** Per-path reasons from the last rename attempt. */
  const [renameFailures, setRenameFailures] = useState<Map<string, string>>(new Map());
  /** Quick Look target, or null. */
  const [quickLook, setQuickLook] = useState<LibraryItem | null>(null);
  const [pickerPath, setPickerPath] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);

  useEffect(() => { saveJson(BROWSER_KEY, prefs); }, [prefs]);
  const patchPrefs = useCallback((p: Partial<BrowserPrefs>) => setPrefs((prev) => ({ ...prev, ...p })), []);

  // The detail panel is non-modal, so opening/closing it must hand keyboard
  // focus back to the card/row that opened it — otherwise a focus-in-panel
  // dismiss (Esc or ✕) drops focus to <body> and Tab restarts at the top.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const openDetail = useCallback((item: LibraryItem, e?: React.MouseEvent) => {
    lastFocusRef.current = document.activeElement as HTMLElement | null;
    const mods = { shift: !!e?.shiftKey, meta: !!(e?.metaKey || e?.ctrlKey) };
    setSel((cur) => clickSelect(cur, itemPathsRef.current, item.path, mods));
    // A modified click is a SELECTION gesture, not a "show me this one"
    // gesture: opening the detail panel on ⌘-click would fight the batch the
    // user is assembling. Plain clicks still open it, as before.
    setDetailItem(mods.shift || mods.meta ? null : item);
  }, []);
  const closeDetail = useCallback(() => {
    setDetailItem(null);
    setSel(EMPTY_SELECTION);
    const el = lastFocusRef.current;
    // rAF defers focus() until after React commits the panel unmount.
    if (el && document.contains(el)) requestAnimationFrame(() => el.focus());
  }, []);

  // Handoff from Home: apply the requested selection and reset the scoped view.
  useEffect(() => {
    setSelected(selection);
    setDetailItem(null);
    setSel(EMPTY_SELECTION);
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

  // Display order, mirrored into a ref so the (stable) click handler can range
  // over exactly what is on screen without re-creating itself on every scan.
  const itemPathsRef = useRef<string[]>([]);
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

  const itemPaths = useMemo(() => items.map((i) => i.path), [items]);
  itemPathsRef.current = itemPaths;
  // A rescan, filter or sort can remove selected files. Dropping them keeps a
  // batch action from ever running over something the user cannot see.
  useEffect(() => { setSel((cur) => pruneSelection(cur, itemPaths)); }, [itemPaths]);
  const selectedPaths = useMemo(() => selectedInOrder(sel, itemPaths), [sel, itemPaths]);
  // Real Finder tags for what is listed. A colour set here lands on the file's
  // own xattr, so it shows in Finder too, and folders already tagged in Finder
  // arrive wearing their colour.
  const finderTags = useFinderTags(itemPaths);

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
      <main className="cp-lib-browse" aria-label="Library">
        <div className="cp-lib-browse-zero">
          <p>Add a folder to build your library.</p>
          <button type="button" className="btn btn-primary" onClick={() => void addFolder()}>
            Add folder
          </button>
        </div>
      </main>
    );
  }

  return (
    <main
      className="cp-lib-browse"
      aria-label="Library"
      onKeyDown={(e) => {
        // ⌘A selects every file ON SCREEN — the filtered, sorted list, not the
        // whole library. Selecting things the user has filtered away is how a
        // batch action ends up touching files they cannot see.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a"
            && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          e.stopPropagation();
          setSel(selectAll(itemPathsRef.current));
          return;
        }
        // Space = Quick Look, Finder's muscle memory. Only with exactly one
        // file in hand: previewing "a selection" is not a meaningful act, and
        // never while typing in the filter box.
        if (e.key === " " && !(e.target instanceof HTMLInputElement)) {
          const one = detailItem
            ?? (sel.selected.size === 1 ? items.find((i) => sel.selected.has(i.path)) : undefined);
          if (one) {
            e.preventDefault();
            e.stopPropagation();
            setQuickLook(one);
            return;
          }
        }
        if (e.key !== "Escape") return;
        // Esc unwinds one layer at a time, most transient first.
        if (sel.selected.size > 1) { e.stopPropagation(); setSel(EMPTY_SELECTION); }
        else if (detailItem) { e.stopPropagation(); closeDetail(); }
        else if (query !== "") { e.stopPropagation(); setQuery(""); setNeedle(""); }
      }}
    >
      {treeOpen && (
        <LibraryTree
          trees={trees}
          selection={selected}
          onSelect={(chain) => { setSelected(chain); setDetailItem(null); setWebView(false); }}
          kind={prefs.kind}
          onKind={(kind) => patchPrefs({ kind })}
          onCollapse={() => setTreeOpen(false)}
          addFolder={addFolder}
          rescanAll={rescanAll}
          scanning={scanning}
          removeRoot={removeRoot}
          webSelected={webView}
          onSelectWeb={() => { setWebView(true); setDetailItem(null); }}
        />
      )}
      <div className="cp-lib-main">
        {webView ? (
          /* The web shelf owns the whole pane. The bar's crumbs, sort and
             search are folder concepts; showing them over a list of URLs
             would offer controls that do nothing. */
          <CachedWebPane onOpenUrl={onOpenWebUrl} />
        ) : (
        <>
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
          <LibrarySelectionBar
            count={selectedPaths.length}
            batchLine={batchLine}
            onBatchCancel={onBatchCancel}
            onTranscribe={onBatchTranscribe ? () => onBatchTranscribe(
              selectedPaths.map((path) => ({
                path,
                name: items.find((i) => i.path === path)?.name ?? path.split("/").pop() ?? path,
              })),
            ) : undefined}
            onReveal={() => {
              // Reveal the FIRST only. Finder opens a window per call, so
              // revealing twelve files buries the screen in twelve windows —
              // the batch equivalent of a popup storm.
              const first = selectedPaths[0];
              if (first) invoke("reveal_in_finder", { path: first }).catch(() => { /* ignore */ });
            }}
            onClear={() => setSel(EMPTY_SELECTION)}
          />
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
            selectedPaths={sel.selected}
            tagsByPath={finderTags.tags}
            onToggleTagColor={(path, index) => {
              // A colour picked from the menu of a file that is PART of a
              // multi-selection applies to the whole set — the menu belongs to
              // the selection at that point, not to the one file under the
              // cursor. Right-clicking outside the selection has already
              // narrowed it to that file (contextMenuSelect), so this is only
              // ever the set the user is looking at.
              const target = sel.selected.has(path) && sel.selected.size > 1
                ? selectedPaths : [path];
              if (target.length > 1) finderTags.toggleMany(target, index);
              else finderTags.toggle(path, index);
            }}
            onClearTagColors={(path) => {
              const target = sel.selected.has(path) && sel.selected.size > 1
                ? selectedPaths : [path];
              for (const p of target) finderTags.clear(p);
            }}
            posterVersions={posterVersions}
            requestThumb={requestThumb}
            onOpen={onOpenLocalPath}
            onReview={onReviewLocalPath}
            onSelectItem={openDetail}
            onContextSelectItem={(item) => setSel((cur) => contextMenuSelect(cur, itemPathsRef.current, item.path))}
            onRenameItem={(item) => {
              // Rename the SELECTION when the clicked file is part of one, so
              // the menu means the same thing as the colour row above it.
              const many = sel.selected.has(item.path) && sel.selected.size > 1
                ? items.filter((i) => sel.selected.has(i.path))
                : [item];
              setRenaming(many);
            }}
            onChoosePoster={setPickerPath}
            onResetPoster={resetPoster}
            onClearSelection={() => { setDetailItem(null); setSel(EMPTY_SELECTION); }}
            onMarqueeEnd={() => { dragBaseRef.current = null; }}
            onMarquee={(paths, mods) => {
              // The band is computed against the selection as it was when the
              // drag STARTED, so sweeping back and forth keeps answering the
              // same thing instead of accumulating everything it crossed.
              setSel((cur) => {
                const base = dragBaseRef.current ?? cur.selected;
                if (dragBaseRef.current == null) dragBaseRef.current = cur.selected;
                return { selected: marqueeSelection(base, paths, mods), anchor: paths[0] ?? cur.anchor };
              });
              setDetailItem(null);
            }}
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
        </>
        )}
      </div>

      {quickLook && (
        <LibraryQuickLook
          path={quickLook.path}
          name={quickLook.name}
          onClose={() => setQuickLook(null)}
          onOpenInClip={() => onOpenLocalPath(quickLook.path)}
        />
      )}
      {renaming && (
        <RenameDialog
          items={renaming.map((it) => ({
            path: it.path,
            modifiedMs: it.modified_ms,
            // The scan has no duration; the dialog only uses it for the
            // {duration} token, which renders empty when unknown.
            durationSec: null,
          }))}
          // Every OTHER file in the same folders, so a rename colliding with a
          // file that was never selected is caught in the preview rather than
          // at the write.
          existingNames={items
            .filter((i) => !renaming.some((r) => r.path === i.path))
            .map((i) => i.path)}
          failures={renameFailures}
          onCancel={() => { setRenaming(null); setRenameFailures(new Map()); }}
          onApply={async (rows) => {
            const results = await applyRenamePlan(
              rows.map((r) => ({ path: r.path, from: r.path.split("/").pop() ?? r.path, to: r.to, problem: null })),
            );
            const failed = results.filter((r) => !r.ok);
            // The rescan re-lists what is actually on disk, so rows that DID
            // rename leave the dialog on their own.
            rescanAll();
            if (failed.length) {
              // Held open with a reason on each bad row. A destructive action
              // that did not happen must never be something the user can walk
              // away from believing it did — which is exactly what a
              // console.warn and a closed dialog amounted to.
              setRenameFailures(new Map(failed.map((f) => [f.from, f.error ?? "Could not rename"])));
              return;
            }
            setRenameFailures(new Map());
            setRenaming(null);
            setSel(EMPTY_SELECTION);
          }}
        />
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
