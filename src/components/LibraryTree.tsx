import { useEffect, useMemo, useRef, useState } from "react";
import { usePaneWidth } from "../hooks/use-pane-width";
import { IconChevronRight, IconLink, IconPanelLeft, IconPlus, IconRefresh, IconStack, IconFolderSolid, IconCamera} from "./Icons";
import type { LibraryFolder } from "../types";
import { libraryPosterPaths, type LibraryCrumb, type LibraryKindFilter } from "../lib/library";
import { FolderTagMenu } from "./FolderTagMenu";
import { useFinderTags } from "../hooks/use-finder-tags";
import { primarySwatch } from "../lib/finder-tags";

type Props = {
  trees: LibraryFolder[];
  /** Current selection chain, or null for the "All" aggregate. */
  selection: LibraryCrumb[] | null;
  onSelect: (chain: LibraryCrumb[] | null) => void;
  /** Kind filter — the panel chips patch the same persisted prefs key. */
  kind: LibraryKindFilter;
  onKind: (kind: LibraryKindFilter) => void;
  /** Hides the panel (the bar's Show folders button brings it back). */
  onCollapse: () => void;
  /** The shared, cached, concurrency-capped thumbnail loader (root art). */
  addFolder: () => Promise<void>;
  rescanAll: () => void;
  scanning: boolean;
  /** Drop a ROOT from the library. Subfolders are not library entries, so
   *  the menu only offers this on depth-0 rows. */
  removeRoot: (root: string) => void;
  /** The cached-web shelf, which is a peer of "All" rather than a folder:
   *  it lists URLs this Mac has resolved, not files in a directory. */
  /** Which special shelf is showing, if any. These are views over a
   *  CATEGORY rather than folders on disk, so they are peers of "All"
   *  rather than of the roots. */
  shelf: "web" | "frames" | null;
  onSelectShelf: (shelf: "web" | "frames") => void;
  /**
   * The folder a drag is hovering, or null. Finder's sidebar is a first-class
   * drop target - "drag files onto any folder listed there" - and it is very
   * often where the destination actually is: the folder you want is one you
   * can see in the tree, not necessarily a subfolder of the one on screen.
   */
  dropOver?: string | null;
};

type Row = {
  /** "all", a shelf id, or `<rootIndex>:<absolute path>` — see buildRows. */
  key: string;
  chain: LibraryCrumb[] | null;
  depth: number;
  name: string;
  hasChildren: boolean;
  expanded: boolean;
  /** Root rows only — the first video under the root, for the folder art. */
  artPath?: string | null;
  /** Set on the two CATEGORY rows. They were rendered outside this array with
   *  a hard-coded tabIndex={-1}, so the roving tabindex never reached them and
   *  neither did ↑/↓ - the Frames and web shelves had no keyboard route at
   *  all, and clicking was the only way in. One list is the truth again. */
  shelf?: "web" | "frames";
};

const KIND_CHIPS: Array<{ kind: LibraryKindFilter; label: string }> = [
  { kind: "all", label: "All" },
  { kind: "video", label: "Video" },
  { kind: "audio", label: "Audio" },
];

function buildRows(trees: LibraryFolder[], expanded: Set<string>): Row[] {
  const rows: Row[] = [
    { key: "all", chain: null, depth: 0, name: "All", hasChildren: false, expanded: false },
    // Directly under "All" because they are the same KIND of thing - a view
    // over everything of a category - rather than folders that happen to live
    // somewhere. Below the roots they would read as one more drive.
    { key: "shelf:web", chain: null, depth: 0, name: "From the web", hasChildren: false, expanded: false, shelf: "web" },
    { key: "shelf:frames", chain: null, depth: 0, name: "Frames", hasChildren: false, expanded: false, shelf: "frames" },
  ];
  const walk = (node: LibraryFolder, chain: LibraryCrumb[], depth: number, rootIdx: number) => {
    const isExp = expanded.has(node.path);
    rows.push({
      // Keyed by WHERE it sits, not by what it is. Roots may nest - the Home
      // view tells the user to add an inner folder as its own root when the
      // scan stops short of it - so the same path legitimately appears twice,
      // once as a root and once inside its parent. Keying on node.path alone
      // made those two rows collide, and React is then free to reuse the wrong
      // DOM node for the wrong folder.
      key: `${rootIdx}:${node.path}`, chain, depth, name: node.name,
      hasChildren: node.folders.length > 0, expanded: isExp,
      // Roots carry small folder art (first video's poster, BFS) — the
      // Spotify library-row read. Subfolders stay text rows.
      artPath: depth === 0 ? (libraryPosterPaths(node, 1)[0] ?? null) : undefined,
    });
    if (isExp) {
      for (const sub of node.folders) {
        walk(sub, [...chain, { name: sub.name, path: sub.path }], depth + 1, rootIdx);
      }
    }
  };
  trees.forEach((t, i) => walk(t, [{ name: t.name, path: t.path }], 0, i));
  return rows;
}

/**
 * The Library browser's left column — a proper library panel: a "Library"
 * header with the collapse toggle, kind filter chips (All / Video / Audio —
 * they patch the same persisted prefs key the bar's select used to), then an
 * ARIA tree over the already-scanned folder trees (no extra IPC). "All"
 * aggregates every root; roots render with small folder art (first video's
 * poster, lazily via the shared thumbnail gate) and disclosure triangles.
 * Selection drives the main pane.
 * Keyboard: ↑↓ move, →/← expand/collapse (or step in/out), Enter/Space select.
 * Add folder + rescan stay pinned at the bottom.
 */
export function LibraryTree({
  trees, selection, onSelect, kind, onKind, onCollapse,
  addFolder, rescanAll, scanning, removeRoot, shelf, onSelectShelf, dropOver,
}: Props) {
  // Roots open by default; ancestors of the current selection are auto-revealed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Each root is default-opened only ONCE (on first appearance) — re-adding it
  // on every selection change would spring a manually-collapsed root back open.
  const seededRoots = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Which roots are new is decided BEFORE the updater, and the ref is
    // mutated here rather than inside it. A setState updater must be pure:
    // StrictMode runs it twice, and the second run would have found every root
    // already seeded and expanded none of them - so in dev a freshly added
    // root quietly failed to open.
    const fresh = trees.filter((t) => !seededRoots.current.has(t.path)).map((t) => t.path);
    for (const path of fresh) seededRoots.current.add(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of fresh) next.add(path);
      if (selection) for (const c of selection) next.add(c.path);
      return next;
    });
  }, [trees, selection]);

  const rows = useMemo(() => buildRows(trees, expanded), [trees, expanded]);
  const selKey = selection ? selection[selection.length - 1].path : "all";
  const [activeKey, setActiveKey] = useState<string>(selKey);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Keep the roving stop valid as rows collapse/expand; follow the selection.
  // A selected shelf keeps the roving stop, rather than the tree snapping the
  // tab stop back to "All" behind the user.
  useEffect(() => { setActiveKey(shelf ? `shelf:${shelf}` : selKey); }, [selKey, shelf]);
  const active = rows.some((r) => r.key === activeKey) ? activeKey : "all";

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });

  const focusRow = (key: string) => { setActiveKey(key); rowRefs.current.get(key)?.focus(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.key === active);
    if (i < 0) return;
    const row = rows[i];
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focusRow(rows[Math.min(i + 1, rows.length - 1)].key); break;
      case "ArrowUp":   e.preventDefault(); focusRow(rows[Math.max(i - 1, 0)].key); break;
      case "Home":      e.preventDefault(); focusRow(rows[0].key); break;
      case "End":       e.preventDefault(); focusRow(rows[rows.length - 1].key); break;
      case "ArrowRight":
        e.preventDefault();
        if (row.hasChildren && !row.expanded) toggle(row.key);
        else if (row.hasChildren && rows[i + 1]) focusRow(rows[i + 1].key);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row.hasChildren && row.expanded) toggle(row.key);
        else { // step out to the parent (first shallower row above)
          for (let j = i - 1; j >= 0; j--) if (rows[j].depth < row.depth) { focusRow(rows[j].key); break; }
        }
        break;
      case "Enter": case " ":
        e.preventDefault();
        // Enter on a shelf row picks the shelf, the way clicking it does -
        // otherwise ↓ could reach the row and Enter would silently select
        // "All" instead.
        if (row.shelf) { setActiveKey(row.key); onSelectShelf(row.shelf); break; }
        onSelect(row.chain);
        break;
    }
  };

  // Drag-to-resize, sharing the app-wide handle design (resize.css) and the
  // drawer's persistence pattern. Width lives on a CSS variable set on the
  // tree element so no other component needs to know about it.
  // The shared pane resizer. The transcripts picker mounts the same one, so
  // two panes that resize cannot resize differently - the clamp, the stored
  // key, the body cursor and the keyboard step are decided in one place.
  const TREE_W_DEFAULT = 224;
  const {
    width: treeWidth, resizing,
    onMouseDown: onResizeMouseDown, onKeyDown: onResizeKeyDown,
  } = usePaneWidth({
    key: "saucebunny.libraryTreeWidth",
    min: 168, max: 420, fallback: TREE_W_DEFAULT,
  });

  /** Right-click target: a real folder row (never the "All" aggregate). */
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; isRoot: boolean } | null>(null);
  // Tags for every visible folder, one bulk read — this is what makes a colour
  // VISIBLE in the tree rather than only inside the menu that set it.
  const folderPaths = useMemo(
    () => rows.filter((r) => r.key !== "all").map((r) => r.key),
    [rows],
  );
  // The focus re-read that used to live here now lives in useFinderTags, so
  // the grid in LibraryBrowser gets it too instead of showing a stale colour
  // beside a fresh one.
  const finderTags = useFinderTags(folderPaths);

  return (
    <div className="cp-lib-tree" style={{ flexBasis: treeWidth }}>
      {/* One row of quiet icon actions beside the title. Add folder used to be
          a full-width green button pinned to the bottom, which made the loudest
          thing in the panel a setup step you perform once per drive — and the
          accent is supposed to mean "playing", not "you may click me". These
          read as tools: dim until hovered, same weight as the collapse toggle
          that already lived here. */}
      <div className="cp-lib-tree-head">
        <h2 className="cp-lib-tree-title">Library</h2>
        <button
          type="button"
          className="cp-lib-tree-act"
          title="Add folder"
          aria-label="Add folder"
          onClick={() => void addFolder()}
        >
          <IconPlus size={14} />
        </button>
        <button
          type="button"
          className={"cp-lib-tree-act" + (scanning ? " scanning" : "")}
          title={scanning ? "Scanning…" : "Rescan library"}
          aria-label="Rescan library"
          onClick={rescanAll}
          disabled={scanning}
        >
          <IconRefresh size={14} />
        </button>
        <button
          type="button"
          className="cp-lib-tree-act"
          title="Hide folder tree"
          aria-label="Hide folder tree"
          onClick={onCollapse}
        >
          <IconPanelLeft size={14} />
        </button>
      </div>
      <div className="cp-lib-tree-chips" role="group" aria-label="Filter by kind">
        {KIND_CHIPS.map((c) => (
          <button
            key={c.kind}
            type="button"
            className={"cp-lib-chip" + (kind === c.kind ? " active" : "")}
            aria-pressed={kind === c.kind}
            onClick={() => onKind(c.kind)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="cp-lib-tree-scroll" role="tree" aria-label="Library folders" onKeyDown={onKeyDown}>
        {rows.map((row) => {
          const isSel = row.shelf ? shelf === row.shelf : (row.key === selKey && shelf === null);
          return (
            <button
              key={row.key}
              ref={(el) => { if (el) rowRefs.current.set(row.key, el); else rowRefs.current.delete(row.key); }}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSel}
              aria-expanded={row.hasChildren ? row.expanded : undefined}
              tabIndex={row.key === active ? 0 : -1}
              className={"cp-lib-tree-row"
                + (row.shelf ? " cp-lib-tree-web" : "")
                + (isSel ? " selected" : "")
                + (dropOver && dropOver === row.key ? " dropping" : "")}
              // A DROP TARGET, but only where a real directory is named.
              // "All" is an aggregate and the two shelf rows are views over a
              // category, so neither is a place a file can be put - and a
              // target that lights up and then refuses is worse than one that
              // never offered.
              data-drop={row.key !== "all" && !row.shelf ? row.key : undefined}
              style={{ ["--depth" as string]: String(row.depth) }}
              onClick={() => {
                setActiveKey(row.key);
                if (row.shelf) { onSelectShelf(row.shelf); return; }
                onSelect(row.chain);
              }}
              onContextMenu={(e) => {
                // "All" is an aggregate, not a folder on disk — nothing to tag
                // or reveal.
                if (row.key === "all" || row.shelf) return;
                e.preventDefault();
                setMenu({ path: row.key, x: e.clientX, y: e.clientY, isRoot: row.depth === 0 });
              }}
            >
              {row.hasChildren ? (
                <span
                  className={"cp-lib-tree-tw" + (row.expanded ? " open" : "")}
                  aria-hidden="true"
                  onClick={(e) => { e.stopPropagation(); toggle(row.key); }}
                >
                  <IconChevronRight size={13} />
                </span>
              ) : (
                <span className="cp-lib-tree-tw empty" aria-hidden="true">
                  {row.key === "all" ? <IconStack size={13} /> : null}
                  {row.shelf === "web" ? <IconLink size={13} /> : null}
                  {row.shelf === "frames" ? <IconCamera size={13} /> : null}
                </span>
              )}
              {row.key !== "all" && !row.shelf && (
                <IconFolderSolid
                  size={15}
                  className="cp-lib-tree-folder"
                  // The tag colour, worn by the folder itself. The glyph is
                  // already a filled folder shape, so tinting it IS the Finder
                  // treatment, with no extra dot competing for row space.
                  style={(() => {
                    const sw = primarySwatch(finderTags.tags.get(row.key) ?? []);
                    return sw ? { color: sw.hex } : undefined;
                  })()}
                />
              )}
              <span className="cp-lib-tree-name">{row.name}</span>
            </button>
          );
        })}
      </div>
      <div
        className={"cp-lib-tree-resize cp-resize-handle vertical" + (resizing ? " dragging" : "")}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize folder panel"
        tabIndex={0}
        onMouseDown={onResizeMouseDown}
        onKeyDown={onResizeKeyDown}
        title="Drag to resize · arrow keys to nudge · Home to reset"
      />
      {menu && (
        <FolderTagMenu
          path={menu.path}
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          onChanged={() => finderTags.refresh()}
          // Roots only: a subfolder is part of a root's scan, not a library
          // entry of its own, so "remove" there would have nothing to remove.
          onRemove={menu.isRoot ? () => removeRoot(menu.path) : undefined}
        />
      )}
    </div>
  );
}
