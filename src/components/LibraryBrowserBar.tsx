import { Fragment } from "react";
import { IconGrid, IconList, IconPanelLeft, IconSearch } from "./Icons";
import type {
  LibraryCrumb, LibraryKindFilter, LibrarySortDir, LibrarySortKey,
} from "../lib/library";

export type LibraryViewMode = "grid" | "list";

type Props = {
  /** Selection chain (null = "All") — drives the breadcrumb. */
  chain: LibraryCrumb[] | null;
  onCrumb: (chain: LibraryCrumb[] | null) => void;
  query: string;
  onQuery: (q: string) => void;
  kind: LibraryKindFilter;
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  view: LibraryViewMode;
  onPrefs: (patch: { kind?: LibraryKindFilter; sort?: LibrarySortKey; dir?: LibrarySortDir; view?: LibraryViewMode }) => void;
  treeOpen: boolean;
  onToggleTree: () => void;
};

/**
 * The Library browser's main-pane header: tree-collapse toggle, clickable
 * breadcrumb, scoped search, kind filter, sort select + asc/desc toggle, and
 * the grid⇄list toggle. All the sort/filter/view prefs persist upstream in one
 * localStorage key; this bar is a pure controlled surface.
 */
export function LibraryBrowserBar({
  chain, onCrumb, query, onQuery, kind, sort, dir, view, onPrefs, treeOpen, onToggleTree,
}: Props) {
  const last = chain ? chain.length - 1 : -1;
  return (
    <div className="cp-lib-bar">
      <button
        type="button"
        className={"cp-lib-bar-tree btn-icon" + (treeOpen ? " active" : "")}
        title={treeOpen ? "Hide folders" : "Show folders"}
        aria-label={treeOpen ? "Hide folder tree" : "Show folder tree"}
        aria-pressed={treeOpen}
        onClick={onToggleTree}
      >
        <IconPanelLeft size={15} />
      </button>
      <nav className="cp-lib-bcrumbs" aria-label="Location">
        {chain === null
          ? <span className="cur" aria-current="page">All</span>
          : <button type="button" onClick={() => onCrumb(null)}>All</button>}
        {chain?.map((c, i) => (
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
            placeholder="Search this folder"
            aria-label="Search this folder"
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
          aria-label="Filter by kind"
          value={kind}
          onChange={(e) => onPrefs({ kind: e.target.value as LibraryKindFilter })}
        >
          <option value="all">All</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
        </select>

        <select
          className="cp-lib-select"
          aria-label="Sort by"
          value={sort}
          onChange={(e) => onPrefs({ sort: e.target.value as LibrarySortKey })}
        >
          <option value="name">Name</option>
          <option value="date">Date modified</option>
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
