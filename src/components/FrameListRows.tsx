import { useState } from "react";
import { useListColumns } from "../hooks/use-list-columns";
import { LibraryCardMenu } from "./LibraryCardMenu";
import { formatBytes } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { formatFrameTimecode, type FrameItem } from "../lib/frames";
import { assetUrl } from "../lib/asset-url";
import { NameHeader } from "./ListColumnHeaders";
import { ListColumnHeaders, ListColumnRules } from "./ListColumnHeaders";
import type { ColSpec } from "./ListColumnHeaders";
import { IconCircleX } from "./Icons";

/**
 * The frames shelf as a table: the same five-track `cp-lib-lrow` grid and
 * the same exported header machinery the folder and web lists use, with the
 * nouns frames want - NAME / Source / SIZE / GRABBED.
 *
 * A sibling rather than an adaptation for the reason WebListRows gives:
 * LibraryListRow is welded to LibraryItem's fields and verbs. The third
 * table is where the column-resize closure would earn extraction, but the
 * three differ in their column KEYS as well as their widths, so lifting it
 * would mean parameterising the very thing that differs. Left alone until a
 * fourth makes the shape obvious.
 */

const COLS_KEY = "saucebunny.frameListCols";
const COL_DEFAULT = { source: 120, size: 84, date: 96 };

/** Source has no sort key of its own: the shelves already group by it, so a
 *  Source sort would duplicate the grouping. */
type FrameColKey = "source" | "size" | "date";
const FRAME_COL_SPECS: readonly ColSpec<FrameColKey>[] = [
  { key: "source", label: "Source", className: "cp-lib-lrow-kind" },
  { key: "size", label: "Size", className: "cp-lib-lrow-size", sort: "size" },
  { key: "date", label: "Grabbed", className: "cp-lib-lrow-date", sort: "date" },
];

function grabbedLabel(unixSeconds: number): string {
  if (!(unixSeconds > 0)) return "";
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    day: "numeric", month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function FrameListRows({ items, sort, dir, onSort, onDelete, onOpenFrame, selected, onSelect, onMove, onRemove, onContextSelect }: {
  items: readonly FrameItem[];
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
  onDelete: (path: string) => void;
  /** The card menu's verbs, so the LIST view offers what the GRID already
   *  does. The grid has had a right-click menu all along (LibraryCard owns
   *  it); only these rows had none, which is why the same shelf behaved two
   *  different ways depending on the view toggle. */
  onMove?: (path: string) => void;
  onRemove?: (path: string) => void;
  /** Finder's rule, same as the library list: right-clicking an UNSELECTED
   *  row makes it the selection first, so the menu acts on what is under the
   *  cursor; a row already in the selection leaves the set intact. */
  onContextSelect?: (path: string) => void;
  onOpenFrame: (path: string) => void;
  /** Multi-select, when the shelf above is running one. Absent leaves the
   *  rows behaving exactly as they did. */
  selected?: ReadonlySet<string>;
  onSelect?: (path: string, e: React.MouseEvent) => void;
}) {
  const colModel = useListColumns(COLS_KEY, COL_DEFAULT);
  const { visible, template } = colModel;

  const [menuAt, setMenuAt] = useState<{ x: number; y: number; path: string } | null>(null);

  return (
    <div
      className="cp-lib-list cp-lib-list-gutter"
      role="list"
      aria-label="Grabbed frames"
      /* One track list from the column model; see WebListRows. */
      style={{ ["--lrow-cols" as string]: template }}
    >
      <div className="cp-lib-list-head" onContextMenu={(e) => e.preventDefault()}>
        <span className="cp-lib-lrow-art" aria-hidden="true" />
        <NameHeader sort={sort} dir={dir} onSort={onSort} model={colModel} />
        <ListColumnHeaders specs={FRAME_COL_SPECS} model={colModel} sort={sort} dir={dir} onSort={onSort} />
      </div>
      {items.map((it) => {
        const tc = formatFrameTimecode(it.timecode);
        return (
          <div key={it.path} role="listitem" className="cp-web-lrow-wrap">
            <button
              type="button"
              data-path={it.path}
              aria-current={selected?.has(it.path) ? "true" : undefined}
              className={"cp-lib-lrow" + (selected?.has(it.path) ? " selected" : "")}
              title={it.path}
              // Selection owns the single click when a selection is
              // running, and opening moves to the double click - the same
              // split LibraryListRow uses. Without a selection above, the
              // single click still opens, exactly as before.
              onClick={(e) => { if (onSelect) onSelect(it.path, e); else onOpenFrame(it.path); }}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextSelect?.(it.path);
                setMenuAt({ x: e.clientX, y: e.clientY, path: it.path });
              }}
              onKeyDown={(e) => {
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  onContextSelect?.(it.path);
                  setMenuAt({ x: r.left + 18, y: r.bottom - 6, path: it.path });
                }
              }}
              onDoubleClick={() => onOpenFrame(it.path)}
            >
              <span className="cp-lib-lrow-art">
                <img src={assetUrl(it.path)} alt="" loading="lazy" />
              </span>
              <span className="cp-lib-lrow-name">
                {it.name}
                {tc && <span className="cp-web-lrow-dur">{tc}</span>}
              </span>
              {/* The clamp hides the tail of a long source title, so the
                  whole thing lives on the hover. */}
              {/* In the header's order, hidden ones absent. */}
              {visible.map((k) => (
                k === "source"
                  ? <span key={k} className="cp-lib-lrow-kind" title={it.source}>{it.source}</span>
                  : k === "size"
                    ? <span key={k} className="cp-lib-lrow-size">{formatBytes(it.size_bytes)}</span>
                    : <span key={k} className="cp-lib-lrow-date">{grabbedLabel(it.created_at)}</span>
              ))}
            </button>
            {/* A list ROW has no ⋯ menu, so the verb is inline here - but
                it asks before it deletes, the same confirm the grid's menu
                item shows. */}
            <button
              type="button"
              className="cp-web-forget list"
              title="Delete this frame from this Mac."
              aria-label={`Delete ${it.name}`}
              onClick={() => onDelete(it.path)}
            >
              <IconCircleX size={13} />
            </button>
          </div>
        );
      })}
      <ListColumnRules template={template} trackCount={colModel.trackCount} lastColumnTrack={colModel.lastColumnTrack} />
      {menuAt && (
        <LibraryCardMenu
          anchor={{ x: menuAt.x, y: menuAt.y }}
          revealPath={menuAt.path}
          onMove={onMove && (() => onMove(menuAt.path))}
          onRemove={onRemove && (() => onRemove(menuAt.path))}
          deleteLabel="Delete frame…"
          onDelete={() => onDelete(menuAt.path)}
          // A still IS its own poster, so there is no frame to pick out of it.
          canPickThumbnail={false}
          hasChosenThumbnail={false}
          onChooseThumbnail={() => {}}
          onResetThumbnail={() => {}}
          onOpen={() => onOpenFrame(menuAt.path)}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  );
}
