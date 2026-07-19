import { LibraryCard } from "./LibraryCard";
import { LibraryListRow } from "./LibraryListRow";
import type { LibraryViewMode } from "./LibraryBrowserBar";
import { formatBytes, formatModifiedDate } from "../lib/library";
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
        {/* Visual column labels only — the rows below are plain buttons, not a
            grid widget, so the header is decorative to assistive tech. */}
        <div className="cp-lib-list-head" aria-hidden="true">
          <span className="cp-lib-lrow-art" />
          <span className="cp-lib-lrow-name">Name</span>
          <span className="cp-lib-lrow-kind">Kind</span>
          <span className="cp-lib-lrow-size">Size</span>
          <span className="cp-lib-lrow-date">Modified</span>
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
