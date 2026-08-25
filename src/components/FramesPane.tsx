import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import {
  filterFrames, formatFrameTimecode, frameCrumbs, frameLevel, groupBySource,
  sortFrames, FRAMES_CHANGED_EVENT, type FrameItem,
} from "../lib/frames";
import { formatBytes } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { assetUrl } from "../lib/asset-url";
import { LibraryBrowserBar, type LibraryViewMode } from "./LibraryBrowserBar";
import { LibraryCard } from "./LibraryCard";
import { LibraryFolderCard } from "./LibraryFolderCard";
import { FrameMoveDialog } from "./FrameMoveDialog";
import { FramePreview, revealFrame } from "./FramePreview";
import { useGridSelection } from "../hooks/use-grid-selection";
import { useMarquee } from "../hooks/use-marquee";
import { useCardDrag } from "../hooks/use-card-drag";
import { LibrarySelectionBar } from "./LibrarySelectionBar";
import { FrameListRows } from "./FrameListRows";

/**
 * Frames — every still grabbed during a review, bundled by the film it came
 * from.
 *
 * Snapshots used to go through a save dialog, so they scattered across the
 * Desktop, Downloads and the export folder, and the app could not show
 * them afterwards because it had no idea where they went. They land in one
 * managed folder now, and this shelf is the other half of that: the same
 * browser bar, the same grid and list views, and the same shared
 * LibraryCard the folder pane and the web shelf use.
 *
 * Bundled BY SOURCE, which is the web shelf's grouping-by-site in the shape
 * frames want. Both derive their groups from data that already exists (a
 * host, a filename stem) rather than from an index that could fall out of
 * step with the directory.
 */

type FramePrefs = { view: LibraryViewMode; sort: LibrarySortKey; dir: LibrarySortDir };
const PREFS_KEY = "saucebunny.framesBrowser";
function normalizeFramePrefs(raw: unknown): FramePrefs {
  const r = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : {};
  const oneOf = <T extends string>(v: unknown, opts: readonly T[], d: T): T =>
    opts.includes(v as T) ? (v as T) : d;
  return {
    view: oneOf(r.view, ["grid", "list"] as const, "grid"),
    sort: oneOf(r.sort, ["name", "date", "size"] as const, "date"),
    dir: oneOf(r.dir, ["asc", "desc"] as const, "desc"),
  };
}

export function FramesPane({ treeOpen, onShowTree }: {
  treeOpen: boolean;
  onShowTree: () => void;
}) {
  const [items, setItems] = useState<FrameItem[] | null>(null);
  // The folders that EXIST, not the ones the frames imply. A folder with
  // nothing in it is invisible to list_frames, which is why New folder looked
  // like it did nothing at all.
  const [diskFolders, setDiskFolders] = useState<string[]>([]);

  const load = useCallback(() => {
    void invoke<string[]>("list_frames_folders")
      .then((f) => setDiskFolders(Array.isArray(f) ? f : []))
      .catch(() => setDiskFolders([]));
    void invoke<FrameItem[]>("list_frames")
      .then(setItems)
      // A folder that cannot be read is an EMPTY shelf, not an error banner:
      // not having grabbed a frame yet is the normal first-run state.
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  // A frame grabbed while this shelf is open should appear on it. The
  // grabber lives in the Clip workspace, so a window-focus re-read is the
  // cheap way to catch both that and anything done in Finder.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    // The event the grabber fires. Focus alone misses the case that actually
    // happens - grab in Clip, walk to Frames, window never lost focus - and
    // this shelf stays MOUNTED behind the others, so there is no remount to
    // fall back on either.
    window.addEventListener(FRAMES_CHANGED_EVENT, onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(FRAMES_CHANGED_EVENT, onFocus);
    };
  }, [load]);

  const [prefs, setPrefs] = useState<FramePrefs>(() => {
    try { return normalizeFramePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null")); }
    catch { return normalizeFramePrefs(null); }
  });
  const prefsRef = useRef(prefs);
  const persist = (next: FramePrefs) => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* quota */ }
  };
  const patchPrefs = useCallback((patch: Partial<FramePrefs>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    persist(next);
    setPrefs(next);
  }, []);
  const onSort = useCallback((key: LibrarySortKey) => {
    const prev = prefsRef.current;
    const next: FramePrefs = prev.sort === key
      ? { ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { ...prev, sort: key, dir: key === "name" ? "asc" : "desc" };
    prefsRef.current = next;
    persist(next);
    setPrefs(next);
  }, []);

  // Which folder is open, "" for the Frames root. A container here is a real
  // directory, so this is just a relative path - there is nothing to look up.
  const [open, setOpen] = useState("");
  const [moving, setMoving] = useState<FrameItem | null>(null);
  // Which frame the viewer is showing, by path. Null = closed.
  const [preview, setPreview] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  /** Returns a message when the folder was REFUSED, null on success. The bar
   *  shows it. This used to swallow every error, so a duplicate name and a
   *  broken command looked identical - and both looked like nothing at all. */
  const createFolder = useCallback(async (name: string): Promise<string | null> => {
    try {
      await invoke("create_frames_folder", { parent: open, name });
      load();
      return null;
    } catch (e) {
      return formatError(e);
    }
  }, [open, load]);

  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    if (query === "") { setNeedle(""); return; }
    const id = window.setTimeout(() => setNeedle(query), 150);
    return () => window.clearTimeout(id);
  }, [query]);

  /** File a set of frames into a folder, then re-read the shelf. */
  const moveMany = useCallback(async (dest: string, paths: readonly string[]) => {
    for (const path of paths) {
      // The command takes the frame's NAME-with-folder, the same relative
      // form list_frames reports, so pass what the item carries.
      try { await invoke("move_frame_to_folder", { path, dest }); }
      catch { /* one refusal must not abandon the rest of the batch */ }
    }
    load();
  }, [load]);

  const remove = useCallback((path: string) => {
    setPreview((p) => (p === path ? null : p));
    // Optimistic: the card goes now, because the disk work is one unlink and
    // waiting on it makes an instant action feel broken.
    setItems((prev) => prev?.filter((i) => i.path !== path) ?? prev);
    void invoke("delete_frame", { path }).catch(load);
  }, [load]);

  // EVERY DERIVATION RUNS BEFORE THE EARLY RETURNS, because the selection
  // hook below needs the displayed order and hooks cannot be called after a
  // conditional return. `all` stands in for a shelf that has not loaded yet,
  // which is the same shape as an empty one.
  const all = items ?? [];

  // ONE level at a time. Search and the list view flatten the whole tree
  // instead - the web pane's rule, and the reason is the same: a needle that
  // matched four folders as four one-row shelves would read as clutter.
  const level = frameLevel(all, open, diskFolders);
  const scoped = needle || prefs.view === "list" ? all : level.here;
  const filtered = filterFrames(scoped, needle);
  const sortedFlat = sortFrames(filtered, prefs.sort, prefs.dir);
  const showFolders = prefs.view === "grid" && !needle && level.folders.length > 0;
  const groups = prefs.view === "list"
    ? (sortedFlat.length ? [{ source: "", items: sortedFlat }] : [])
    : needle
      ? (filtered.length ? [{ source: "Results", items: sortedFlat }] : [])
      // A frame filed into a folder leaves the stem shelves: it has been
      // filed, and showing it in both places makes the fold read as a search
      // result rather than an organisation. So stem-grouping serves whatever
      // sits loose at THIS level.
      : groupBySource(level.here).map((g) => ({
          source: g.source,
          items: sortFrames(g.items, prefs.sort, prefs.dir),
        }));
  const bytes = all.reduce((n, i) => n + i.size_bytes, 0);
  // Exactly what is on screen, in the order it is on screen - so the
  // viewer's Left/Right walk the shelf the user is looking at rather than
  // some private order, and stepping crosses source bundles the way the eye
  // does.
  const shown = groups.flatMap((g) => g.items);
  // The same order the marquee and shift-click run ranges over: what is on
  // screen, as it is on screen.
  const grid = useGridSelection(shown.map((f) => f.path));
  const { selectedPaths } = grid;
  const marquee = useMarquee({
    containerRef: paneRef,
    itemSelector: ".cp-lib-card",
    // Cards here live inside a per-source section, so the gaps between them
    // belong to the section or its grid rather than to the scroll container.
    // Without naming those, a band could only start on the pane's padding.
    gutterSelector: ".cp-web-grid, .cp-web-shelf, .cp-web-summary",
    onSelect: grid.onMarquee,
    onEnd: grid.onMarqueeEnd,
  });
  const cardDrag = useCardDrag({
    itemSelector: ".cp-lib-card:not(.cp-lib-foldercard)",
    targetSelector: ".cp-lib-foldercard",
    targetAttr: "data-drop",
    // Finder's rule: dragging a card that is part of the selection drags the
    // whole selection; dragging one outside it drags only that one.
    pathsFor: (path) => (grid.selected.has(path) ? grid.selectedPaths : [path]),
    onDrop: (dest, paths) => {
      void moveMany(dest, paths);
      grid.clear();
    },
  });

  const band = marquee.band && (
    <div
      className="cp-lib-marquee"
      aria-hidden="true"
      style={{
        left: marquee.band.left,
        top: marquee.band.top,
        width: marquee.band.right - marquee.band.left,
        height: marquee.band.bottom - marquee.band.top,
      }}
    />
  );

  if (items === null) return <div className="cp-web-empty">Reading your frames…</div>;
  if (items.length === 0) {
    return (
      <div className="cp-web-empty">
        No frames yet. Press the camera in the player to grab the frame you are
        looking at, and it will land here.
      </div>
    );
  }

  // Batch verbs act on the selection when the clicked item is part of it,
  // and on the clicked item alone otherwise - the rule every file manager
  // uses, and the one the folder pane already follows.
  const removeMany = (paths: readonly string[]) => {
    const n = paths.length;
    if (!confirm(n === 1
      ? `Delete this frame? It is removed from this Mac.`
      : `Delete ${n} frames? They are removed from this Mac.`)) return;
    for (const p of paths) remove(p);
    grid.clear();
  };

  const frameCard = (it: FrameItem) => {
    const tc = formatFrameTimecode(it.timecode);
    return (
      <LibraryCard
        key={it.path}
        title={it.name}
        detail={`${it.source}${it.size_bytes ? ` · ${formatBytes(it.size_bytes)}` : ""}`}
        // A still IS its own poster - point the card's remote art at the file
        // through the asset protocol rather than asking the thumbnailer to
        // decode a video frame out of a JPEG.
        art={{ kind: "remote", url: assetUrl(it.path) }}
        duration={tc}
        revealPath={it.path}
        // Identity for selection, the band and drag. Frames show REMOTE art
        // (the still is its own poster, through the asset protocol), and the
        // card used to take its identity from local art only - which is why
        // this shelf had no working selection at all.
        selectionPath={it.path}
        selected={grid.selected.has(it.path)}
        onSelect={(e) => grid.onItemClick(it.path, e)}
        onOpen={() => setPreview(it.path)}
        requestThumb={async () => null}
        // Delete lives in the card's ⋯ menu, beside Reveal in Finder and
        // Open in Clip, because that is where a card's verbs live. It asks
        // first: one file, and every other destructive action in this app
        // asks. No armed second click - that pattern belongs to a control
        // you can press twice, and a menu closes on the first.
        onMove={() => setMoving(it)}
        deleteLabel="Delete frame…"
        onDelete={() => {
          if (!confirm(`Delete ${it.name}? It is removed from this Mac.`)) return;
          remove(it.path);
        }}
      />
    );
  };

  return (
    <div className="cp-web-view">
      <LibraryBrowserBar
        chain={frameCrumbs(open)}
        onCrumb={(c) => setOpen(c === null ? "" : (c.at(-1)?.path ?? ""))}
        location="Frames"
        dateLabel="Date grabbed"
        searchLabel="Search frames"
        query={query}
        onQuery={setQuery}
        sort={prefs.sort}
        dir={prefs.dir}
        view={prefs.view}
        onPrefs={patchPrefs}
        treeOpen={treeOpen}
        onShowTree={onShowTree}
        onNewFolder={createFolder}
      />
      {cardDrag.drag && (
        <div
          className="cp-card-ghost"
          aria-hidden="true"
          style={{ left: cardDrag.drag.x, top: cardDrag.drag.y }}
        >
          {cardDrag.drag.paths.length}
          {cardDrag.drag.paths.length === 1 ? " frame" : " frames"}
        </div>
      )}
      {preview && (
        <FramePreview
          items={shown}
          path={preview}
          onPath={setPreview}
          onClose={() => setPreview(null)}
          onReveal={revealFrame}
        />
      )}
      {moving && (
        <FrameMoveDialog
          name={moving.path}
          currentFolder={moving.folder ?? ""}
          // Every folder in the tree, so a frame can be filed anywhere -
          // derived from the items themselves, since the directories ARE the
          // index here.
          folders={[...new Set(items.map((i) => i.folder ?? "").filter(Boolean))].sort()}
          onMoved={load}
          onClose={() => setMoving(null)}
        />
      )}
      <LibrarySelectionBar
        count={selectedPaths.length}
        onReveal={() => { const f = selectedPaths[0]; if (f) revealFrame(f); }}
        onMove={() => {
          // One dialog for the whole selection: the destination is the same
          // for all of them, so asking once per frame would be ceremony.
          const first = all.find((f) => f.path === selectedPaths[0]);
          if (first) setMoving(first);
        }}
        onDelete={() => removeMany(selectedPaths)}
        onClear={grid.clear}
      />
      <div
        ref={paneRef}
        className="cp-web-pane"
        onClick={(e) => { if (!marquee.dragging() && e.target === e.currentTarget) grid.clear(); }}
        {...marquee.handlers}
        // The two gestures do not overlap: the band starts only on blank
        // space, the drag only on a card. Both need the same three pointer
        // handlers, so they are composed rather than stacked.
        onPointerDown={(e) => { marquee.handlers.onPointerDown(e); cardDrag.handlers.onPointerDown(e); }}
        onPointerMove={(e) => { marquee.handlers.onPointerMove(e); cardDrag.handlers.onPointerMove(e); }}
        onPointerUp={() => { marquee.handlers.onPointerUp(); cardDrag.handlers.onPointerUp(); }}
        onPointerCancel={() => { marquee.handlers.onPointerCancel(); cardDrag.handlers.onPointerCancel(); }}
        onClickCapture={cardDrag.handlers.onClickCapture}
      >
        {band}
        <div className="cp-web-summary">
          {items.length} {items.length === 1 ? "frame" : "frames"}
          {bytes > 0 ? ` · ${formatBytes(bytes)} on disk` : ""}
        </div>
        {showFolders && (
          <div className="cp-web-grid" role="list" aria-label="Folders">
            {level.folders.map((f) => (
              <LibraryFolderCard
                key={f.path}
                name={f.name}
                count={f.count}
                // Derived cover: the three newest stills beneath it. A still
                // is its own poster, so requestThumb is a synchronous
                // asset-URL wrapper rather than the video thumbnailer.
                posterPaths={f.covers}
                requestThumb={async (p) => assetUrl(p)}
                dropKey={f.path}
                dropActive={cardDrag.drag?.over === f.path}
                onOpen={() => setOpen(f.path)}
              />
            ))}
          </div>
        )}
        {needle && groups.length === 0 && (
          <div className="cp-web-empty">No frames match "{needle.trim()}".</div>
        )}
        {groups.map((g) => (
          <section key={g.source || "list"} className="cp-web-shelf">
            {g.source !== "" && (
              <h3 className="cp-web-shelf-head">
                {g.source}
                <span className="cp-web-count">{g.items.length}</span>
              </h3>
            )}
            {prefs.view === "list" ? (
              <FrameListRows
                items={g.items}
                sort={prefs.sort}
                dir={prefs.dir}
                onSort={onSort}
                onOpenFrame={setPreview}
                onDelete={(p) => {
                  const row = g.items.find((x) => x.path === p);
                  if (!row) return;
                  if (!confirm(`Delete ${row.name}? It is removed from this Mac.`)) return;
                  remove(p);
                }}
              />
            ) : (
              <div className="cp-web-grid" role="list">{g.items.map(frameCard)}</div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
