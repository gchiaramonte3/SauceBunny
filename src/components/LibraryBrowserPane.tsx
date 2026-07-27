import { LibraryCard } from "./LibraryCard";
import { LibraryListRow } from "./LibraryListRow";
import type { LibraryViewMode } from "./LibraryBrowserBar";
import { formatBytes, formatModifiedDate } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import type { LibraryItem } from "../types";

type Props = {
  items: LibraryItem[];
  view: LibraryViewMode;
  /** Path of the current detail selection, for the highlight. */
  selectedPath: string | null;
  posterVersions: Record<string, number>;
  requestThumb: (path: string) => Promise<string | null>;
  onOpen: (path: string) => void;
  onReview?: (path: string) => void;
  onSelectItem: (item: LibraryItem) => void;
  onChoosePoster: (path: string) => void;
  onResetPoster: (path: string) => void;
  /** Clears the selection on a click in the empty gutter. */
  onClearSelection: () => void;
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
export function LibraryBrowserPane({
  items, view, selectedPath, posterVersions, requestThumb,
  onOpen, onReview, onSelectItem, onChoosePoster, onResetPoster, onClearSelection, emptyText,
  sort, dir, onSort,
}: Props) {
  const clearOnBlank = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClearSelection();
  };

  if (items.length === 0) {
    return <div className="cp-lib-pane"><p className="cp-lib-note cp-lib-browse-empty">{emptyText}</p></div>;
  }

  if (view === "grid") {
    return (
      <div className="cp-lib-pane cp-lib-browse-grid" role="list" aria-label="Files" onClick={clearOnBlank}>
        {items.map((it) => (
          <LibraryCard
            key={`${it.path}#${posterVersions[it.path] ?? 0}`}
            title={it.name}
            detail={[formatBytes(it.size_bytes), formatModifiedDate(it.modified_ms)].filter(Boolean).join(" · ")}
            art={{ kind: "local", path: it.path, media: it.kind }}
            onOpen={() => onOpen(it.path)}
            onReview={onReview ? () => onReview(it.path) : undefined}
            onSelect={() => onSelectItem(it)}
            selected={selectedPath === it.path}
            onChoosePoster={onChoosePoster}
            onResetPoster={onResetPoster}
            requestThumb={requestThumb}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="cp-lib-pane" onClick={clearOnBlank}>
      <div className="cp-lib-list" role="list" aria-label="Files">
        {/* Column headers that SORT.
            These were decorative aria-hidden spans that looked exactly like
            Finder's sortable headers and did nothing when clicked — a control
            the UI advertised and did not honour. They drive the same persisted
            pref the bar's picker does, so the two stay in step. "Kind" has no
            sort key of its own (the bar filters by kind instead), so it stays
            a plain label rather than pretending. */}
        <div className="cp-lib-list-head">
          <span className="cp-lib-lrow-art" aria-hidden="true" />
          <SortHeader className="cp-lib-lrow-name" label="Name" col="name" sort={sort} dir={dir} onSort={onSort} />
          <span className="cp-lib-lrow-kind">Kind</span>
          <SortHeader className="cp-lib-lrow-size" label="Size" col="size" sort={sort} dir={dir} onSort={onSort} />
          <SortHeader className="cp-lib-lrow-date" label="Modified" col="date" sort={sort} dir={dir} onSort={onSort} />
        </div>
        {items.map((it) => (
          <LibraryListRow
            key={`${it.path}#${posterVersions[it.path] ?? 0}`}
            item={it}
            selected={selectedPath === it.path}
            onSelect={() => onSelectItem(it)}
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
function SortHeader({ className, label, col, sort, dir, onSort }: {
  className: string;
  label: string;
  col: LibrarySortKey;
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
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
    </button>
  );
}
