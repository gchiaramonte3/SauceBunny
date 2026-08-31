import { Fragment, useEffect, useRef, useState } from "react";
import { IconGrid, IconList, IconPanelLeft, IconPlus, IconSearch } from "./Icons";
import type { LibraryCrumb, LibrarySortDir, LibrarySortKey } from "../lib/library";

export type LibraryViewMode = "grid" | "list";

type Props = {
  /**
   * The folder a drag is hovering, or null.
   *
   * Finder's Path Bar is a documented drop target - "you can move items into
   * the appropriate folder in the Path Bar" - and it is the only gesture that
   * moves a file UP the tree without first navigating away from it.
   */
  dropOver?: string | null;
  /** Selection chain (null = "All") — drives the breadcrumb. */
  chain: LibraryCrumb[] | null;
  onCrumb: (chain: LibraryCrumb[] | null) => void;
  /** The ROOT crumb's label, replacing "All" — "From the web", "Frames".
   *  It is a crumb, not a crumb SUPPRESSOR: the bar used to have two modes
   *  (a fixed label OR a chain), and collapsing them to one is what lets a
   *  shelf with real folders navigate out of the same header the folder
   *  pane already mounts. A shelf with no chain simply passes none. */
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
  /**
   * Make a container at the level currently being browsed.
   *
   * IT LIVES HERE so that every shelf gets the SAME control in the SAME
   * place. It was built once, for the frames shelf, tucked into that pane's
   * count line - which put an organising verb in a status readout, in a
   * different spot from every other verb, and left the Library with no way
   * to make a folder at all. A header that three shelves already share is
   * the one place a shared affordance can be added once.
   *
   * The bar owns the naming field too, for the same reason: identical
   * behaviour everywhere is not something each caller should re-implement.
   * Rejecting the name is the caller's job - it is the one that knows what
   * already exists on disk - so this reports back what it is told.
   */
  onNewFolder?: (name: string, destination: string) => Promise<string | null> | string | null | void;
  /** "New folder" unless a shelf calls its containers something else. */
  newFolderLabel?: string;
  /**
   * WHERE the new container can go. One entry means no question to ask; more
   * than one puts a chooser in the form.
   *
   * This exists because "nothing happens" was the Library's most common
   * outcome. At "All" - the view you land on - the button did not render at
   * all, on the reasoning that a union of roots has no single directory to
   * create in. The reasoning is right and the outcome is wrong: a control
   * present on one screen and absent on the next, with nothing said, reads as
   * broken rather than as honest.
   *
   * The ambiguity is real, so the fix is to ANSWER it rather than to hide from
   * it. One root and there was never a question. Several and the form asks,
   * which is the one moment a chooser earns its place.
   *
   * A shelf that has a single obvious destination (frames, collections) passes
   * one entry and sees no chooser at all - the behaviour it had before.
   */
  newFolderTargets?: readonly { path: string; label: string }[];
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
  chain, onCrumb, location, dateLabel, searchLabel, query, onQuery, sort, dir, view, onPrefs, treeOpen, onShowTree, dropOver,
  onNewFolder, newFolderLabel, newFolderTargets,
}: Props) {
  const last = chain ? chain.length - 1 : -1;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (naming) inputRef.current?.focus(); }, [naming]);

  // The chosen destination, only ever asked about when there is more than one.
  const targets = newFolderTargets ?? [];
  const [dest, setDest] = useState<string>("");
  const chosen = dest || targets[0]?.path || "";

  const closeNaming = () => { setNaming(false); setName(""); setErr(null); setBusy(false); setDest(""); };
  const submitName = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    // The caller returns a message to REFUSE - a duplicate name is the
    // ordinary case and the user has to see it, which is the half the frames
    // shelf was missing: its create swallowed every error, so a refused name
    // and a broken command looked identical, and both looked like nothing
    // happening.
    const refusal = await onNewFolder?.(trimmed, chosen);
    if (typeof refusal === "string" && refusal) { setErr(refusal); setBusy(false); return; }
    closeNaming();
  };
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
        {chain === null || chain.length === 0
          ? <span className="cur" aria-current="page">{location ?? "All"}</span>
          : <button type="button" onClick={() => onCrumb(null)}>{location ?? "All"}</button>}
        {chain?.map((c, i) => (
          <Fragment key={c.path}>
            <span className="sep" aria-hidden="true">/</span>
            {i === last
              // The folder you are already IN. Not a drop target: dropping a
              // file where it already lives is a no-op, and a target that
              // lights up to do nothing is a lie.
              ? <span className="cur" aria-current="page">{c.name}</span>
              : (
                <button
                  type="button"
                  className={dropOver === c.path ? "dropping" : undefined}
                  data-drop={c.path}
                  onClick={() => onCrumb(chain.slice(0, i + 1))}
                >
                  {c.name}
                </button>
              )}
          </Fragment>
        ))}
      </nav>

      <div className="cp-lib-bar-controls">
        {onNewFolder && (naming ? (
          <form
            className="cp-newfolder-form"
            onSubmit={(e) => { e.preventDefault(); void submitName(); }}
          >
            <input
              ref={inputRef}
              type="text"
              className="cp-newfolder-input"
              value={name}
              placeholder={`${newFolderLabel ?? "New folder"} name`}
              aria-label={`${newFolderLabel ?? "New folder"} name`}
              spellCheck={false}
              disabled={busy}
              onChange={(e) => { setName(e.target.value); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); closeNaming(); } }}
            />
            <button type="submit" className="btn cp-tx-iconbtn" disabled={busy || !name.trim()}>Create</button>
            <button type="button" className="btn btn-ghost cp-tx-iconbtn" onClick={closeNaming} disabled={busy}>Cancel</button>
            {err && <span className="cp-newfolder-err" role="alert">{err}</span>}
          </form>
        ) : (
          <button
            type="button"
            className="cp-newfolder-btn"
            title={newFolderLabel ?? "New folder"}
            aria-label={newFolderLabel ?? "New folder"}
            onClick={() => setNaming(true)}
          >
            <IconPlus size={12} />
            {newFolderLabel ?? "New folder"}
          </button>
        ))}
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
          className="cp-select cp-lib-select"
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
