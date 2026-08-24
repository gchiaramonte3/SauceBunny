import { Fragment } from "react";
import { IconGrid, IconList, IconPanelLeft, IconSearch } from "./Icons";
import type { LibraryCrumb, LibrarySortDir, LibrarySortKey } from "../lib/library";

export type LibraryViewMode = "grid" | "list";

type Props = {
  /** Selection chain (null = "All") — drives the breadcrumb. */
  chain: LibraryCrumb[] | null;
  onCrumb: (chain: LibraryCrumb[] | null) => void;
  /** A fixed location name replacing the breadcrumb entirely — the web view
   *  has no folder chain, and crumbs over a list of URLs would be chrome
   *  pretending to navigate. The bar is otherwise identical, which is the
   *  point: one header to learn. */
  location?: string;
  /** What "date" means here: "Date modified" for files, "Date fetched" for
   *  the web cache. A wrong label is worse than a new prop. */
  dateLabel?: string;
  /** Search placeholder + accessible name; the default is folder-speak. */
  searchLabel?: string;
  query: string;
  onQuery: (q: string) => void;
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  view: LibraryViewMode;
  onPrefs: (patch: { sort?: LibrarySortKey; dir?: LibrarySortDir; view?: LibraryViewMode }) => void;
  /** Panel visibility — the bar only shows a reopen affordance while hidden
   *  (the collapse control lives in the panel's own header). */
  treeOpen: boolean;
  onShowTree: () => void;
};

/**
 * The Library browser's main-pane header: clickable breadcrumb, scoped
 * search, sort select + asc/desc toggle, and the grid⇄list toggle. The kind
 * filter moved to the library panel's chips (LibraryTree); the panel's
 * collapse toggle moved into its header, so the bar only carries the Show
 * folders button while the panel is hidden. All the sort/view prefs persist
 * upstream in one localStorage key; this bar is a pure controlled surface.
 */
export function LibraryBrowserBar({
  chain, onCrumb, location, dateLabel, searchLabel, query, onQuery, sort, dir, view, onPrefs, treeOpen, onShowTree,
}: Props) {
  const last = chain ? chain.length - 1 : -1;
  return (
    <div className="cp-lib-bar">
      {!treeOpen && (
        <button
          type="button"
          className="cp-lib-bar-tree btn-icon"
          title="Show folder tree"
          aria-label="Show folder tree"
          onClick={onShowTree}
        >
          <IconPanelLeft size={15} />
        </button>
      )}
      <nav className="cp-lib-bcrumbs" aria-label="Location">
        {location != null ? <span className="cur" aria-current="page">{location}</span> : chain === null
          ? <span className="cur" aria-current="page">All</span>
          : <button type="button" onClick={() => onCrumb(null)}>All</button>}
        {location == null && chain?.map((c, i) => (
          <Fragment key={c.path}>
            <span className="sep" aria-hidden="true">/</span>
            {i === last
              ? <span className="cur" aria-current="page">{c.name}</span>
              : <button type="button" onClick={() => onCrumb(chain.slice(0, i + 1))}>{c.name}</button>}
          </Fragment>
        ))}
      </nav>

      <div className="cp-lib-bar-controls">
        <div className="cp-lib-bar-search">
          <IconSearch size={12} />
          <input
            type="text"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={searchLabel ?? "Search this folder"}
            aria-label={searchLabel ?? "Search this folder"}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
          />
          {query !== "" && (
            <button type="button" className="cp-lib-search-clear" aria-label="Clear search" onClick={() => onQuery("")}>×</button>
          )}
        </div>

        <select
          className="cp-lib-select"
          aria-label="Sort by"
          value={sort}
          onChange={(e) => onPrefs({ sort: e.target.value as LibrarySortKey })}
        >
          <option value="name">Name</option>
          <option value="date">{dateLabel ?? "Date modified"}</option>
          <option value="size">Size</option>
        </select>
        <button
          type="button"
          className="btn-icon cp-lib-bar-dir"
          title={dir === "asc" ? "Ascending" : "Descending"}
          aria-label={`Sort direction: ${dir === "asc" ? "ascending" : "descending"}`}
          onClick={() => onPrefs({ dir: dir === "asc" ? "desc" : "asc" })}
        >
          {dir === "asc" ? "↑" : "↓"}
        </button>

        <div className="cp-lib-viewtoggle" role="group" aria-label="View mode">
          <button
            type="button"
            className={"btn-icon" + (view === "grid" ? " active" : "")}
            title="Grid" aria-label="Grid view" aria-pressed={view === "grid"}
            onClick={() => onPrefs({ view: "grid" })}
          >
            <IconGrid size={15} />
          </button>
          <button
            type="button"
            className={"btn-icon" + (view === "list" ? " active" : "")}
            title="List" aria-label="List view" aria-pressed={view === "list"}
            onClick={() => onPrefs({ view: "list" })}
          >
            <IconList size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
