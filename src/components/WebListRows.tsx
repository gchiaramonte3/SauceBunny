import { useState } from "react";
import { useListColumns } from "../hooks/use-list-columns";
import { formatBytes, listFillPhase } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { siteName, type CachedWebItem } from "../lib/web-source";
import { secondsToClock } from "../lib/timecode";
import { NameHeader } from "./ListColumnHeaders";
import { IconDownload, IconLink } from "./Icons";
import { ListColumnHeaders, ListColumnRules } from "./ListColumnHeaders";
import { LibraryCardMenu } from "./LibraryCardMenu";
import type { ColSpec } from "./ListColumnHeaders";

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
 *
 * RIGHT-CLICK REACHES THE SAME VERBS THE GRID HAS. The grid draws these items
 * with LibraryCard, which carries a menu; switching to list view silently took
 * every verb except the inline one away, and a right-click fell through to
 * WKWebView's own menu - so the list looked like the same table with fewer
 * powers for no stated reason. This is the same parity the frames list was
 * given, using the same component, so the two lists cannot drift apart.
 */

const COLS_KEY = "saucebunny.webListCols";
const COL_DEFAULT = { site: 88, size: 84, date: 96 };

/** Site has no sort key of its own: the shelves already group by it, so a
 *  Site sort would duplicate the grouping. Plain label, like Kind next door. */
type WebColKey = "site" | "size" | "date";
const WEB_COL_SPECS: readonly ColSpec<WebColKey>[] = [
  { key: "site", label: "Site", className: "cp-lib-lrow-kind" },
  { key: "size", label: "Size", className: "cp-lib-lrow-size", sort: "size" },
  { key: "date", label: "Fetched", className: "cp-lib-lrow-date", sort: "date" },
];

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
  const colModel = useListColumns(COLS_KEY, COL_DEFAULT);
  const { visible, template } = colModel;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; url: string } | null>(null);
  const menuItem = menuAt ? items.find((i) => i.url === menuAt.url) ?? null : null;

  return (
    <div
      className="cp-lib-list"
      role="list"
      aria-label="Cached web sources"
      /* One track list, computed from the column model and read by the
         header and every row. See .cp-monitor-stack's sibling reasoning in
         library.css: three --col-* variables against a fixed five-track
         template cannot express a hidden or reordered column. */
      style={{ ["--lrow-cols" as string]: template, ["--lrow-fill-phase" as string]: String(listFillPhase(items.length)) }}
    >
      <div className="cp-lib-list-head" onContextMenu={(e) => e.preventDefault()}>
        <span className="cp-lib-lrow-art" aria-hidden="true" />
        <NameHeader sort={sort} dir={dir} onSort={onSort} model={colModel} />
        <ListColumnHeaders specs={WEB_COL_SPECS} model={colModel} sort={sort} dir={dir} onSort={onSort} />
      </div>
      {items.map((it) => {
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
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuAt({ x: e.clientX, y: e.clientY, url: it.url });
              }}
              // Keyboard parity: the menu key and Shift+F10 are how this is
              // reached without a mouse, and a menu only a mouse can open is
              // not a menu everyone has.
              onKeyDown={(e) => {
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenuAt({ x: r.left + 18, y: r.bottom - 6, url: it.url });
                }
              }}
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
              {/* In the header's order, hidden ones absent. */}
              {visible.map((k) => (
                k === "site"
                  ? <span key={k} className="cp-lib-lrow-kind">{siteName(it.url)}</span>
                  : k === "size"
                    ? <span key={k} className="cp-lib-lrow-size">{it.size_bytes ? formatBytes(it.size_bytes) : ""}</span>
                    : <span key={k} className="cp-lib-lrow-date">{fetchedLabel(it.fetched_at)}</span>
              ))}
            </button>
          </div>
        );
      })}
      <ListColumnRules template={template} trackCount={colModel.trackCount} lastColumnTrack={colModel.lastColumnTrack} />
      {menuAt && menuItem && (
        <LibraryCardMenu
          anchor={{ x: menuAt.x, y: menuAt.y }}
          // Only a DOWNLOADED copy has somewhere to be revealed. A
          // resolve-only entry is a URL and nothing else, so the menu must
          // not offer to show it in Finder.
          revealPath={menuItem.path ?? null}
          onOpen={() => onOpenUrl(menuAt.url)}
          // ONE verb, not two. The grid separates "forget the entry" from
          // "delete the downloaded copy" because it holds both handlers. The
          // list is handed a single `onForget`, which already adds the
          // delete-the-copy confirm when a copy exists - so wiring both menu
          // items to it produced two rows that did exactly the same thing and
          // raised exactly the same prompt. The label says which case it is.
          deleteLabel={menuItem.path ? "Delete the copy…" : "Forget this clip"}
          onDelete={() => onForget(menuAt.url)}
          // A web source's poster comes from the site, so there is no local
          // frame to pick out of it - the same answer the frames list gives.
          canPickThumbnail={false}
          hasChosenThumbnail={false}
          onChooseThumbnail={() => {}}
          onResetThumbnail={() => {}}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  );
}
