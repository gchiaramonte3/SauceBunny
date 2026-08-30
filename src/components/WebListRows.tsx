import { useListColumns } from "../hooks/use-list-columns";
import { formatBytes } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { siteName, type CachedWebItem } from "../lib/web-source";
import { secondsToClock } from "../lib/timecode";
import { ColDivider, SortHeader } from "./LibraryBrowserPane";
import { IconCircleX, IconDownload, IconLink } from "./Icons";

/**
 * The web cache as a table — the Library list view's sibling for items that
 * are URLs rather than paths. Same five-track `cp-lib-lrow` grid, the same
 * exported SortHeader/ColDivider, and its own persisted column widths, so it
 * reads as the same table with different nouns: NAME / Site / SIZE / FETCHED.
 *
 * A sibling of LibraryListRow rather than an adaptation of it: that row is
 * welded to LibraryItem paths (reveal, tag dot, slow-click rename), and
 * threading web-only fields through it would hand a file inspector a URL.
 *
 * The column-resize closure is duplicated from LibraryBrowserPane on
 * purpose - two consumers, and the house rule extracts shared stateful logic
 * at three. If a third table appears, lift it then.
 */

const COLS_KEY = "saucebunny.webListCols";
const COL_DEFAULT = { site: 88, size: 84, date: 96 };

/** "Yesterday", "3 Aug" - matches the folder list's date shape closely
 *  enough to sit in the same column without a new formatter. */
function fetchedLabel(unixSeconds: number): string {
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

export function WebListRows({ items, sort, dir, onSort, onForget, onOpenUrl, selected, onSelect }: {
  items: readonly CachedWebItem[];
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
  onForget: (url: string) => void;
  onOpenUrl: (url: string) => void;
  /** Multi-select, when the shelf above is running one. A web source's
   *  identity is its URL, the same key the grid cards select on. */
  selected?: ReadonlySet<string>;
  onSelect?: (url: string, e: React.MouseEvent) => void;
}) {
  const { cols, dragCol, startColDrag } = useListColumns(COLS_KEY, COL_DEFAULT);

  return (
    <div
      className="cp-lib-list"
      role="list"
      aria-label="Cached web sources"
      style={{
        ["--col-kind" as string]: `${cols.site}px`,
        ["--col-size" as string]: `${cols.size}px`,
        ["--col-date" as string]: `${cols.date}px`,
      }}
    >
      <div className="cp-lib-list-head">
        <span className="cp-lib-lrow-art" aria-hidden="true" />
        <SortHeader className="cp-lib-lrow-name" label="Name" col="name" sort={sort} dir={dir} onSort={onSort}>
          <ColDivider onDown={startColDrag("site")} active={dragCol === "site"} />
        </SortHeader>
        {/* Site has no sort key of its own - the shelves already group by it,
            so a Site sort would duplicate the grouping. Plain label, like the
            folder list's Kind. */}
        <span className="cp-lib-lrow-kind">
          Site
          <ColDivider onDown={startColDrag("size")} active={dragCol === "size"} />
        </span>
        <SortHeader className="cp-lib-lrow-size" label="Size" col="size" sort={sort} dir={dir} onSort={onSort}>
          <ColDivider onDown={startColDrag("date")} active={dragCol === "date"} />
        </SortHeader>
        <SortHeader className="cp-lib-lrow-date" label="Fetched" col="date" sort={sort} dir={dir} onSort={onSort} />
      </div>
      {items.map((it) => {
        const size = it.size_bytes ? formatBytes(it.size_bytes) : "the copy";
        return (
          <div key={it.url} role="listitem" className="cp-web-lrow-wrap">
            <button
              type="button"
              data-path={it.url}
              aria-current={selected?.has(it.url) ? "true" : undefined}
              className={"cp-lib-lrow" + (selected?.has(it.url) ? " selected" : "")}
              title={it.url}
              // Selection owns the single click when a selection is
              // running, and opening moves to the double click - the same
              // split LibraryListRow uses. Without a selection above, the
              // single click still opens, exactly as before.
              onClick={(e) => { if (onSelect) onSelect(it.url, e); else onOpenUrl(it.url); }}
              onDoubleClick={() => onOpenUrl(it.url)}
            >
              <span className="cp-lib-lrow-art">
                {it.thumbnail
                  ? <img src={it.thumbnail} alt="" loading="lazy" />
                  : <IconLink size={13} />}
              </span>
              <span className="cp-lib-lrow-name">
                {it.title ?? it.url}
                {it.duration_seconds != null && (
                  <span className="cp-web-lrow-dur">{secondsToClock(it.duration_seconds)}</span>
                )}
                {it.path && (
                  <span className="cp-web-lrow-have" title="A full copy is on this Mac">
                    <IconDownload size={10} />
                  </span>
                )}
              </span>
              <span className="cp-lib-lrow-kind">{siteName(it.url)}</span>
              <span className="cp-lib-lrow-size">{it.size_bytes ? formatBytes(it.size_bytes) : ""}</span>
              <span className="cp-lib-lrow-date">{fetchedLabel(it.fetched_at)}</span>
            </button>
            {/* A list ROW has no ⋯ menu, so the verb is inline - and the
                caller asks before deleting a downloaded copy, the same
                confirm the grid's menu item shows. */}
            <button
              type="button"
              className="cp-web-forget list"
              title={it.path
                ? "Delete the downloaded copy from this Mac. The source stays online."
                : "Forget this resolve. Nothing is on disk; re-opening extracts again."}
              aria-label={it.path
                ? `Delete the ${size} copy of ${it.title ?? it.url}`
                : `Forget ${it.title ?? it.url}`}
              onClick={() => onForget(it.url)}
            >
              <IconCircleX size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
