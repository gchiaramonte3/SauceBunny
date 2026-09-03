import { useMemo, useRef, useState } from "react";
import { useListColumns } from "../hooks/use-list-columns";
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
import { ListColumnHeaders, ListColumnRules, NameHeader } from "./ListColumnHeaders";
import { useCustomColumns, CUSTOM_COL_WIDTH } from "../hooks/use-custom-columns";
import type { ColSpec } from "./ListColumnHeaders";
import type { LibColKey } from "../lib/library";

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
  /** A folder's tags were written from its own menu; re-read them. */
  onTagsChanged?: () => void;
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
  /** Forget these paths without touching the files. Takes a LIST because
   *  the same verb serves one right-clicked row and a whole selection. */
  onRemoveItems?: (paths: readonly string[]) => void;
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
    drag: { x: number; y: number; paths: readonly string[]; over: string | null; copy: boolean } | null;
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

const COLS_KEY = "saucebunny.libraryListCols";
const COL_DEFAULT = { kind: 64, size: 84, date: 96 };

/** The three optional columns, and what each one is called and sorts by.
 *  "Kind" has no sort key of its own - the browse bar filters by kind
 *  instead - so it stays a plain label rather than pretending to sort. */
const LIB_COL_SPECS: readonly ColSpec<LibColKey>[] = [
  { key: "kind", label: "Kind", className: "cp-lib-lrow-kind" },
  { key: "size", label: "Size", className: "cp-lib-lrow-size", sort: "size" },
  { key: "date", label: "Modified", className: "cp-lib-lrow-date", sort: "date" },
];

export function LibraryBrowserPane({
  folders = EMPTY_FOLDERS, onOpenFolder,
  items, view, selectedPath, selectedPaths, tagsByPath, onToggleTagColor, onClearTagColors, onTagsChanged, posterVersions, requestThumb,
  onOpen, onReview, onSelectItem, onContextSelectItem, onRenameItem, onTrashItem, onRemoveItems, onChoosePoster, onResetPoster, onClearSelection, onMarquee, onMarqueeEnd, onMoveToFolder, onRequestMove, onKeyboardSelect, cardDrag, emptyText,
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
  const custom = useCustomColumns();
  /* The open cell editor. It lives HERE rather than in the row because a row
     is a <button>: an <input> inside one is invalid content and misbehaves on
     click, so the editor floats over the cell's box instead of nesting in it. */
  const [editCell, setEditCell] = useState<
    { path: string; id: string; box: { x: number; y: number; width: number } } | null
  >(null);
  /* A custom column is just another key to the column model, which is the
     whole point: it gets resizing, reordering and hide/show from the machinery
     that already exists rather than from a parallel implementation. Merging
     the widths in here is the entire integration.
     useListColumns reconciles the two cases this creates - it appends keys
     it has never seen (a column just added) and drops keys no longer in the
     defaults (one just deleted). It only did that at MOUNT until it was
     caught: a column added at runtime never rendered, and a deleted one left
     an invisible width track behind. */
  const colDefaults = useMemo(
    () => ({
      ...COL_DEFAULT,
      ...Object.fromEntries(custom.columns.map((c) => [c.id, CUSTOM_COL_WIDTH])),
    }) as Record<string, number>,
    [custom.columns],
  );
  const colModel = useListColumns(COLS_KEY, colDefaults);
  const colSpecs = useMemo<readonly ColSpec<string>[]>(
    () => [
      ...LIB_COL_SPECS,
      // No `sort` key: sorting is over the library's own comparators, and a
      // user-made column has none. A heading that looks sortable and does
      // nothing is worse than one that plainly does not.
      ...custom.columns.map((c) => ({
        key: c.id, label: c.label, className: "cp-lib-lrow-custom",
      })),
    ],
    [custom.columns],
  );
  const { visible, template } = colModel;

  const marquee = useMarquee({
    containerRef: paneRef,
    itemSelector: view === "grid" ? ".cp-lib-card" : ".cp-lib-lrow",
    onSelect: (paths, mods) => onMarquee?.(paths, mods),
    onEnd: () => onMarqueeEnd?.(),
  });

  /** What a drag is carrying, shown under the pointer. */
  const ghostEl = cardDrag?.drag && (
    <div className="cp-card-ghost" style={{ left: cardDrag.drag.x, top: cardDrag.drag.y }}>
      {/* Which act this is, said on the thing under the pointer. Apple changes
          the POINTER for exactly this reason - a copy and a move look
          identical right up to the moment one of them is wrong. */}
      {cardDrag.drag.copy ? "Copy " : ""}
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
            /* Folders get the same right-click as files: the tag row and
               Reveal. Both were missing here, so the browse area was the one
               place in the app where a folder had no colour and no menu. */
            path={f.path}
            tags={tagsByPath?.get(f.path)}
            onTagsChanged={onTagsChanged}
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
            /* The whole selection when the row is part of one, otherwise
               just this row - the same rule the other row verbs follow. */
            onRemove={onRemoveItems ? () => onRemoveItems(
              selectedPaths?.has(it.path) ? [...selectedPaths] : [it.path],
            ) : undefined}
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
        /* ONE track list, on the container, read by the header and by every
           row. It was three separate --col-* variables against a hardcoded
           five-track template, which cannot express a hidden or reordered
           column: the width would still be reserved and the cells would still
           come out in source order. */
        style={{ ["--lrow-cols" as string]: template }}
      >
        {/* Column headers that SORT.
            These were decorative aria-hidden spans that looked exactly like
            Finder's sortable headers and did nothing when clicked — a control
            the UI advertised and did not honour. They drive the same persisted
            pref the bar's picker does, so the two stay in step. "Kind" has no
            sort key of its own (the bar filters by kind instead), so it stays
            a plain label rather than pretending. */}
        <div className="cp-lib-list-head" onContextMenu={(e) => e.preventDefault()}>
          <span className="cp-lib-lrow-art" aria-hidden="true" />
          <NameHeader sort={sort} dir={dir} onSort={onSort} model={colModel} />
          {/* Every other column: sortable, resizable, dragged to reorder,
              and hideable from a right-click menu. Name stays outside because
              it is the 1fr track and, as in Finder, cannot be moved or turned
              off. */}
          <ListColumnHeaders specs={colSpecs} model={colModel} sort={sort} dir={dir} onSort={onSort} custom={custom} />
        </div>
        {/* Containers first, exactly as the grid does it - and as `names`
            above assumes. Rendering only files here both hid a folder of
            folders behind a blank pane and put type-ahead out of step by the
            folder count. */}
        {folders.map((f) => (
          <LibraryFolderRow
            key={f.path}
            columns={visible}
            folder={f}
            dropActive={cardDrag?.drag?.over === f.path}
            onOpen={() => onOpenFolder?.(f)}
            tags={tagsByPath?.get(f.path)}
            onTagsChanged={onTagsChanged}
          />
        ))}
        {items.map((it) => (
          <LibraryListRow
            key={`${it.path}#${posterVersions[it.path] ?? 0}`}
            columns={visible}
            customText={(id) => custom.valueFor(it.path, id)}
            customColumns={custom.columns}
            onEditCustom={(id, box) => setEditCell({ path: it.path, id, box })}
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
            /* The whole selection when the row is part of one, otherwise
               just this row - the same rule the other row verbs follow. */
            onRemove={onRemoveItems ? () => onRemoveItems(
              selectedPaths?.has(it.path) ? [...selectedPaths] : [it.path],
            ) : undefined}
            onMove={onMoveToFolder ? () => onRequestMove?.(it.path) : undefined}
            onOpen={() => onOpen(it.path)}
            onReview={onReview ? () => onReview(it.path) : undefined}
            requestThumb={requestThumb}
            onChoosePoster={onChoosePoster}
            onResetPoster={onResetPoster}
          />
        ))}
        <ListColumnRules template={template} trackCount={colModel.trackCount} lastColumnTrack={colModel.lastColumnTrack} />
      </div>
      {editCell && (
        <input
          className="cp-lib-cell-edit"
          autoFocus
          maxLength={200}
          aria-label={`${custom.columns.find((c) => c.id === editCell.id)?.label ?? "Column"} for ${editCell.path.split("/").pop() ?? ""}`}
          defaultValue={custom.valueFor(editCell.path, editCell.id)}
          style={{ left: editCell.box.x, top: editCell.box.y, width: Math.max(editCell.box.width, 120) }}
          onKeyDown={(e) => {
            // Stopped, or the list's own shortcuts (space to preview, delete
            // to trash, the roving arrows) act on the row while you type.
            e.stopPropagation();
            if (e.key === "Enter") { custom.setValue(editCell.path, editCell.id, e.currentTarget.value); setEditCell(null); }
            else if (e.key === "Escape") { setEditCell(null); }
          }}
          // Commit on blur, which is what a bin cell does. Escape above is the
          // way to leave without saving.
          onBlur={(e) => { custom.setValue(editCell.path, editCell.id, e.currentTarget.value); setEditCell(null); }}
        />
      )}
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
/**
 * The drag handle between two list columns.
 *
 * THIS WAS MOUSE-ONLY: a span with `onMouseDown` and nothing else - no
 * tabIndex, no key handler - while carrying `role="separator"` and
 * `aria-label="Resize column"`. That combination advertises an interactive
 * control to a screen reader and then offers no way to operate it (WCAG 2.1.1
 * Keyboard, Level A), and ARIA's own definition of a focusable separator is a
 * window splitter, which is expected to carry a value and respond to arrows.
 *
 * Nothing caught it. `target-size.spec.ts` enumerates pointer targets by role
 * and its selector lists `[role="slider"]` but not `[role="separator"]`, so a
 * 10px-wide drag target was invisible to it; `popover-focus.spec.ts` exercises
 * three named triggers and never reaches a list header.
 *
 * The app already knew how to do this. `Timeline` is `role="slider"` with
 * tabIndex, aria-valuemin/max/now, an `aria-valuetext` that reads a timecode
 * instead of a frame count, and arrow keys - and all three of the app's
 * sliders are built that way. This is the same shape of control and simply
 * had not been given the same treatment.
 *
 * Arrow keys move by 8px, shift-arrow by 24, Home/End jump to the bounds. The
 * clamp lives in the hook so the keyboard and the mouse cannot stop at
 * different widths.
 */
export function ColDivider({ onDown, active, label, value, min, max, onNudge, onReset }: {
  onDown: (e: React.MouseEvent) => void;
  active: boolean;
  /** Which column, so the name is not three identical "Resize column"s. */
  label?: string;
  value?: number;
  min?: number;
  max?: number;
  /** `host` is the header cell this divider sits in. The Name column has no
   *  stored width while it sizes to the pane, so its keyboard path has to
   *  measure what is on screen; passing the element is how it can. Callers
   *  that already know their width ignore the second argument. */
  onNudge?: (delta: number, host: HTMLElement | null) => void;
  /** Double-click to give the column back to the layout. Finder does this;
   *  without it, setting an explicit width is a one-way door. */
  onReset?: () => void;
}) {
  const step = 8;
  return (
    <span
      className={"cp-lib-coldiv" + (active ? " dragging" : "")}
      role="separator"
      aria-orientation="vertical"
      aria-label={label ? `Resize ${label} column` : "Resize column"}
      // A separator only becomes a splitter - operable, with a value - once it
      // is focusable. Without tabIndex the value attributes below mean nothing.
      tabIndex={onNudge ? 0 : undefined}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={value != null ? `${Math.round(value)} pixels` : undefined}
      title="Drag, or focus and use the arrow keys"
      onMouseDown={onDown}
      onKeyDown={onNudge && ((e) => {
        const big = e.shiftKey ? 3 : 1;
        const host = e.currentTarget.parentElement;
        if (e.key === "ArrowLeft") { e.preventDefault(); onNudge(-step * big, host); }
        else if (e.key === "ArrowRight") { e.preventDefault(); onNudge(step * big, host); }
        // Home/End are the splitter idiom for "as small / as large as it goes".
        // A large delta is enough because the hook clamps.
        else if (e.key === "Home") { e.preventDefault(); onNudge(-9999, host); }
        else if (e.key === "End") { e.preventDefault(); onNudge(9999, host); }
        // The keyboard equivalent of the double-click below.
        else if (onReset && (e.key === "Backspace" || e.key === "Delete")) {
          e.preventDefault(); onReset();
        }
      })}
      onDoubleClick={onReset && ((e) => { e.preventDefault(); e.stopPropagation(); onReset(); })}
      // The header cell is a sort BUTTON; without this the divider's click
      // bubbles into it and every resize also re-sorts the table.
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function SortHeader({ className, label, col, sort, dir, onSort, children, cellProps }: {
  className: string;
  label: string;
  col: LibrarySortKey;
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
  /** The resize divider on this cell's right edge, if it has one. */
  children?: React.ReactNode;
  /** Drag-to-reorder handlers and the context menu, when this header is one
   *  of the movable columns. Spread FIRST so the sort click below cannot be
   *  overwritten by a caller. */
  /*  `& { draggable?: boolean }` used to widen this, back when reorder was an
   *  HTML5 drag. It is gone with the gesture, and gone deliberately rather
   *  than left harmless: on macOS a `draggable` element starts a real
   *  NSDragging session, which Tauri's webview drag-drop listener reads as a
   *  file entering the window and answers with the full-screen import card.
   *  Without this member the type no longer admits the attribute, so the door
   *  is shut by the compiler instead of by remembering. */
  cellProps?: React.HTMLAttributes<HTMLButtonElement>;
}) {
  const active = sort === col;
  return (
    <button
      {...cellProps}
      type="button"
      className={`${className} cp-lib-sorthead` + (active ? " active" : "") + (cellProps?.className ? ` ${cellProps.className}` : "")}
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
