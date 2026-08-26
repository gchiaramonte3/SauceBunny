import { useEffect, useMemo, useRef, useState } from "react";
import { LibraryCard } from "./LibraryCard";
import { LibraryListRow } from "./LibraryListRow";
import { LibraryFolderCard } from "./LibraryFolderCard";
import { LibraryFolderRow } from "./LibraryFolderRow";
import type { LibraryViewMode } from "./LibraryBrowserBar";
import { countLibraryItems, formatBytes, formatModifiedDate, libraryPosterPaths } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { useRovingGrid } from "../hooks/use-roving-grid";
import { useMarquee } from "../hooks/use-marquee";
import type { LibraryFolder, LibraryItem } from "../types";

type Props = {
  items: LibraryItem[];
  /** Subfolders of the current selection, shown as container tiles above
   *  the files. Empty in "All" and while searching. */
  folders?: LibraryFolder[];
  onOpenFolder?: (f: LibraryFolder) => void;
  view: LibraryViewMode;
  /** Path of the current DETAIL selection — the one whose info panel shows. */
  selectedPath: string | null;
  /** Every selected path, for the highlight. Superset of selectedPath. */
  selectedPaths?: ReadonlySet<string>;
  /** Finder tags by path, for the colour dot and the menu's colour row. */
  tagsByPath?: ReadonlyMap<string, readonly import("../bindings/FinderTag").FinderTag[]>;
  onToggleTagColor?: (path: string, index: import("../lib/finder-tags").TagColorIndex) => void;
  onClearTagColors?: (path: string) => void;
  posterVersions: Record<string, number>;
  requestThumb: (path: string) => Promise<string | null>;
  onOpen: (path: string) => void;
  onReview?: (path: string) => void;
  onSelectItem: (item: LibraryItem, e: React.MouseEvent) => void;
  /** Right-click landed on this item; apply Finder's select-then-menu rule. */
  onContextSelectItem?: (item: LibraryItem) => void;
  /** Rename: the pane hands back the item the menu was opened on. */
  onRenameItem?: (item: LibraryItem) => void;
  /**
   * Move this file to the Finder Trash.
   *
   * The frames shelf and the web shelf have always had a removal verb and
   * the file wall had none at all - the one shelf holding somebody's actual
   * footage was the one with no way to get rid of anything. It is the Trash
   * rather than a delete because this app has no undo of its own.
   */
  onTrashItem?: (item: LibraryItem) => void;
  onChoosePoster: (path: string) => void;
  onResetPoster: (path: string) => void;
  /** Clears the selection on a click in the empty gutter. */
  onClearSelection: () => void;
  /** Live rubber-band result: the paths the band covers, plus its modifiers. */
  onMarquee?: (paths: string[], mods: { shift: boolean; meta: boolean }) => void;
  onMarqueeEnd?: () => void;
  /** Drop `paths` into the folder at `dest`. Absent = no drag-to-file. */
  onMoveToFolder?: (dest: string, paths: readonly string[]) => void;
  /** "Move to folder…" was chosen from a card's menu — open the picker. */
  onRequestMove?: (path: string) => void;
  /** The keyboard moved onto `path`; apply the same rule a click would. */
  onKeyboardSelect?: (path: string, mods: { shift: boolean; meta: boolean }) => void;
  /**
   * The drag lives in LibraryBrowser, not here, because it spans BOTH the pane
   * and the folder tree beside it: Finder's sidebar is a drop target, and a
   * hook owned by one of the two panels could only ever highlight its own.
   */
  cardDrag?: {
    drag: { x: number; y: number; paths: readonly string[]; over: string | null } | null;
    handlers: {
      onPointerDown: (e: React.PointerEvent) => void;
      onPointerMove: (e: React.PointerEvent) => void;
      onPointerUp: () => void;
    };
  };
  emptyText: string;
  /** Current sort, so the list headers can show and toggle it. */
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
};

/**
 * The Library browser's scrolling content region — a poster wall (grid) or a
 * compact table (list) of the selection's media. Both card kinds use single-
 * click-selects / double-click-opens semantics and the shared thumbnail loader.
 * A click on the blank gutter clears the detail selection.
 */
/** Stable empty default: a fresh [] each render would re-run the names
 *  memo, and through it the roving grid, on every parent render. */
const EMPTY_FOLDERS: LibraryFolder[] = [];

export function LibraryBrowserPane({
  folders = EMPTY_FOLDERS, onOpenFolder,
  items, view, selectedPath, selectedPaths, tagsByPath, onToggleTagColor, onClearTagColors, posterVersions, requestThumb,
  onOpen, onReview, onSelectItem, onContextSelectItem, onRenameItem, onTrashItem, onChoosePoster, onResetPoster, onClearSelection, onMarquee, onMarqueeEnd, onMoveToFolder, onRequestMove, onKeyboardSelect, cardDrag, emptyText,
  sort, dir, onSort,
}: Props) {


  // Finder's keyboard: one Tab stop for the whole wall, arrows to walk it in
  // two dimensions, Home/End, and type-ahead to jump to a name. The card and
  // the row are different elements, so the selector follows the view.
  const paneRef = useRef<HTMLDivElement>(null);
  // Folder names FIRST, matching the render order below. useRovingGrid takes
  // its names from here but reads its elements from
  // querySelectorAll(".cp-lib-card") - and LibraryFolderCard deliberately
  // shares that class - so a folder tile in the grid without its name here
  // puts the two lists out of sync BY INDEX, and type-ahead silently jumps to
  // the wrong tile. Nothing throws; it just goes subtly wrong.
  const names = useMemo(
    () => [...folders.map((f) => f.name), ...items.map((i) => i.name)],
    [folders, items],
  );
  const roving = useRovingGrid({
    containerRef: paneRef,
    itemSelector: view === "grid" ? ".cp-lib-card" : ".cp-lib-lrow",
    names,
    layout: view,
    // Finder moves the SELECTION with the arrow keys, not just a focus ring,
    // and Shift extends it. `names` lists folders first and then files, which
    // is the render order — so an index past the folders is a file, and the
    // ones before it are containers the selection does not cover.
    onNavigate: (index, mods) => {
      const fileIndex = index - folders.length;
      const path = fileIndex >= 0 ? items[fileIndex]?.path : undefined;
      if (path) onKeyboardSelect?.(path, mods);
    },
  });

  // Column widths, persisted. Applied on the list CONTAINER so the header and
  // every row inherit the same variables — resizing one element and not the
  // other is how a table goes crooked.
  const COLS_KEY = "saucebunny.libraryListCols";
  const COL_MIN = 48;
  const COL_MAX = 240;
  const COL_DEFAULT = { kind: 64, size: 84, date: 96 };
  const [cols, setCols] = useState<{ kind: number; size: number; date: number }>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLS_KEY) ?? "null");
      if (raw && typeof raw === "object") {
        const pick = (v: unknown, d: number) =>
          typeof v === "number" && v >= COL_MIN && v <= COL_MAX ? v : d;
        return {
          kind: pick(raw.kind, COL_DEFAULT.kind),
          size: pick(raw.size, COL_DEFAULT.size),
          date: pick(raw.date, COL_DEFAULT.date),
        };
      }
    } catch { /* mangled value costs the defaults, not a crash */ }
    return COL_DEFAULT;
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch { /* quota */ }
  }, [cols]);
  const [dragCol, setDragCol] = useState<null | keyof typeof COL_DEFAULT>(null);
  const startColDrag = (key: keyof typeof COL_DEFAULT) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // never let the divider press also sort the column
    const startX = e.clientX;
    const startW = cols[key];
    setDragCol(key);
    document.body.classList.add("cp-resizing-ew");
    const onMove = (ev: MouseEvent) => {
      // Dragging RIGHT widens the column to the divider's left, which is the
      // one the handle belongs to.
      const next = Math.max(COL_MIN, Math.min(COL_MAX, startW + (ev.clientX - startX)));
      setCols((c: { kind: number; size: number; date: number }) => ({ ...c, [key]: next }));
    };
    const onUp = () => {
      setDragCol(null);
      document.body.classList.remove("cp-resizing-ew");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const marquee = useMarquee({
    containerRef: paneRef,
    itemSelector: view === "grid" ? ".cp-lib-card" : ".cp-lib-lrow",
    onSelect: (paths, mods) => onMarquee?.(paths, mods),
    onEnd: () => onMarqueeEnd?.(),
  });

  /** What a drag is carrying, shown under the pointer. */
  const ghostEl = cardDrag?.drag && (
    <div className="cp-card-ghost" style={{ left: cardDrag.drag.x, top: cardDrag.drag.y }}>
      {cardDrag.drag.paths.length}
      {cardDrag.drag.paths.length === 1 ? " file" : " files"}
    </div>
  );

  /** Both gestures share one pointer surface: the band starts on blank space,
   *  the drag starts on a card, so they never both claim a press. */
  const gestures = cardDrag ? {
    onPointerDown: (e: React.PointerEvent) => { marquee.handlers.onPointerDown(e); cardDrag.handlers.onPointerDown(e); },
    onPointerMove: (e: React.PointerEvent) => { marquee.handlers.onPointerMove(e); cardDrag.handlers.onPointerMove(e); },
    onPointerUp: () => { marquee.handlers.onPointerUp(); cardDrag.handlers.onPointerUp(); },
  } : marquee.handlers;

  /** The band itself, painted in the pane's own content coordinates. */
  const bandEl = marquee.band && (
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

  const clearOnBlank = (e: React.MouseEvent) => {
    // A band that ended on the gutter still fires a click there. Clearing on it
    // would wipe the selection the drag just made.
    if (marquee.dragging()) return;
    if (e.target === e.currentTarget) onClearSelection();
  };

  // FOLDERS COUNT AS CONTENT. A folder holding only subfolders is not empty,
  // and gating this on items alone hid every one of its containers behind
  // "nothing here" - the mirror of the bug where a root showed folder tiles
  // and none of its films.
  if (items.length === 0 && folders.length === 0) {
    return <div className="cp-lib-pane"><p className="cp-lib-note cp-lib-browse-empty">{emptyText}</p></div>;
  }

  if (view === "grid") {
    return (
      <div
        ref={paneRef}
        className="cp-lib-pane cp-lib-browse-grid"
        role="list"
        aria-label="Files"
        onClick={clearOnBlank}
        onKeyDown={roving.onKeyDown}
        onFocusCapture={roving.onFocusCapture}
        {...gestures}
      >
        {bandEl}
        {ghostEl}
        {/* Containers first, then this folder's own files - Finder's order,
            and the order `names` above assumes. The cover is derived from the
            folder's contents (libraryPosterPaths), never stored. */}
        {folders.map((f) => (
          <LibraryFolderCard
            key={f.path}
            name={f.name}
            count={countLibraryItems(f)}
            posterPaths={libraryPosterPaths(f, 3)}
            requestThumb={requestThumb}
            dropKey={f.path}
            dropActive={cardDrag?.drag?.over === f.path}
            onOpen={() => onOpenFolder?.(f)}
          />
        ))}
        {items.map((it) => (
          <LibraryCard
            key={`${it.path}#${posterVersions[it.path] ?? 0}`}
            title={it.name}
            detail={[formatBytes(it.size_bytes), formatModifiedDate(it.modified_ms)].filter(Boolean).join(" · ")}
            art={{ kind: "local", path: it.path, media: it.kind }}
            onOpen={() => onOpen(it.path)}
            onReview={onReview ? () => onReview(it.path) : undefined}
            tags={tagsByPath?.get(it.path)}
            onToggleTagColor={onToggleTagColor ? (i) => onToggleTagColor(it.path, i) : undefined}
            onClearTagColors={onClearTagColors ? () => onClearTagColors(it.path) : undefined}
            deleteLabel="Move to Trash…"
            onDelete={onTrashItem ? () => onTrashItem(it) : undefined}
            // The drag's keyboard-reachable twin. This menu item has existed
            // behind LibraryCardMenu's `onMove` all along; the Library was the
            // one pane that never passed it.
            onMove={onMoveToFolder ? () => onRequestMove?.(it.path) : undefined}
            onSelect={(e) => onSelectItem(it, e)}
            onContextSelect={() => onContextSelectItem?.(it)}
            onRename={onRenameItem ? () => onRenameItem(it) : undefined}
            selected={selectedPaths ? selectedPaths.has(it.path) : selectedPath === it.path}
            onChoosePoster={onChoosePoster}
            onResetPoster={onResetPoster}
            requestThumb={requestThumb}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={paneRef}
      className="cp-lib-pane"
      onClick={clearOnBlank}
      onKeyDown={roving.onKeyDown}
      onFocusCapture={roving.onFocusCapture}
      {...gestures}
    >
      {bandEl}
      {ghostEl}
      <div
        className="cp-lib-list"
        role="list"
        aria-label="Files"
        style={{
          ["--col-kind" as string]: `${cols.kind}px`,
          ["--col-size" as string]: `${cols.size}px`,
          ["--col-date" as string]: `${cols.date}px`,
        }}
      >
        {/* Column headers that SORT.
            These were decorative aria-hidden spans that looked exactly like
            Finder's sortable headers and did nothing when clicked — a control
            the UI advertised and did not honour. They drive the same persisted
            pref the bar's picker does, so the two stay in step. "Kind" has no
            sort key of its own (the bar filters by kind instead), so it stays
            a plain label rather than pretending. */}
        <div className="cp-lib-list-head">
          <span className="cp-lib-lrow-art" aria-hidden="true" />
          <SortHeader className="cp-lib-lrow-name" label="Name" col="name" sort={sort} dir={dir} onSort={onSort}>
            {/* Each divider sits on the header cell to its RIGHT and widens the
                column it borders. stopPropagation on the press is what keeps a
                resize from also firing that column's sort. */}
            <ColDivider onDown={startColDrag("kind")} active={dragCol === "kind"} />
          </SortHeader>
          <span className="cp-lib-lrow-kind">
            Kind
            <ColDivider onDown={startColDrag("size")} active={dragCol === "size"} />
          </span>
          <SortHeader className="cp-lib-lrow-size" label="Size" col="size" sort={sort} dir={dir} onSort={onSort}>
            <ColDivider onDown={startColDrag("date")} active={dragCol === "date"} />
          </SortHeader>
          <SortHeader className="cp-lib-lrow-date" label="Modified" col="date" sort={sort} dir={dir} onSort={onSort} />
        </div>
        {/* Containers first, exactly as the grid does it - and as `names`
            above assumes. Rendering only files here both hid a folder of
            folders behind a blank pane and put type-ahead out of step by the
            folder count. */}
        {folders.map((f) => (
          <LibraryFolderRow
            key={f.path}
            folder={f}
            dropActive={cardDrag?.drag?.over === f.path}
            onOpen={() => onOpenFolder?.(f)}
          />
        ))}
        {items.map((it) => (
          <LibraryListRow
            key={`${it.path}#${posterVersions[it.path] ?? 0}`}
            item={it}
            selected={selectedPaths ? selectedPaths.has(it.path) : selectedPath === it.path}
            tags={tagsByPath?.get(it.path)}
            onToggleTagColor={onToggleTagColor ? (i) => onToggleTagColor(it.path, i) : undefined}
            onClearTagColors={onClearTagColors ? () => onClearTagColors(it.path) : undefined}
            onSelect={(e) => onSelectItem(it, e)}
            onContextSelect={() => onContextSelectItem?.(it)}
            onRename={onRenameItem ? () => onRenameItem(it) : undefined}
            deleteLabel="Move to Trash…"
            onDelete={onTrashItem ? () => onTrashItem(it) : undefined}
            onMove={onMoveToFolder ? () => onRequestMove?.(it.path) : undefined}
            onOpen={() => onOpen(it.path)}
            onReview={onReview ? () => onReview(it.path) : undefined}
            requestThumb={requestThumb}
            onChoosePoster={onChoosePoster}
            onResetPoster={onResetPoster}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One sortable column header. Clicking the active column flips direction,
 * which is the behaviour every macOS list view has; clicking another column
 * switches to it without inheriting the previous column's direction, so
 * "Modified" always starts newest-first the way a user expects.
 */
/** The 6px grab strip between two header cells. Exported: the web cache's
 *  list view mounts the same header machinery (see WebListRows). */
export function ColDivider({ onDown, active }: { onDown: (e: React.MouseEvent) => void; active: boolean }) {
  return (
    <span
      className={"cp-lib-coldiv" + (active ? " dragging" : "")}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      onMouseDown={onDown}
      // The header cell is a sort BUTTON; without this the divider's click
      // bubbles into it and every resize also re-sorts the table.
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function SortHeader({ className, label, col, sort, dir, onSort, children }: {
  className: string;
  label: string;
  col: LibrarySortKey;
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
  /** The resize divider on this cell's right edge, if it has one. */
  children?: React.ReactNode;
}) {
  const active = sort === col;
  return (
    <button
      type="button"
      className={`${className} cp-lib-sorthead` + (active ? " active" : "")}
      // Screen readers get the state as a real sort contract, not an arrow
      // glyph they cannot see.
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(col)}
    >
      {label}
      {active && <span className="cp-lib-sorthead-caret" aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span>}
      {children}
    </button>
  );
}
