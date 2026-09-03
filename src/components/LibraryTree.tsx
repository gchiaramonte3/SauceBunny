import { useEffect, useMemo, useRef, useState } from "react";
import { usePaneWidth } from "../hooks/use-pane-width";
import { IconChevronRight, IconLink, IconPanelLeft, IconPlus, IconRefresh, IconStack, IconFolderSolid, IconCamera, IconReview,
} from "./Icons";
import type { LibraryFolder } from "../types";
import { libraryPosterPaths, type LibraryCrumb, type LibraryKindFilter } from "../lib/library";
import { FolderTagMenu } from "./FolderTagMenu";
import { useFinderTags } from "../hooks/use-finder-tags";
import { primarySwatch } from "../lib/finder-tags";

/** Which folders are open. Persisted so a deep library does not cost the
 *  same four expansions on every launch. */
const EXPANDED_KEY = "saucebunny.libraryTreeExpanded";

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
  shelf: "web" | "frames" | "sessions" | null;
  onSelectShelf: (shelf: "web" | "frames" | "sessions") => void;
  /**
   * The folder a drag is hovering, or null. Finder's sidebar is a first-class
   * drop target - "drag files onto any folder listed there" - and it is very
   * often where the destination actually is: the folder you want is one you
   * can see in the tree, not necessarily a subfolder of the one on screen.
   */
  dropOver?: string | null;
};

type Row = {
  /** "all", a shelf id, or `<rootIndex>:<absolute path>` — see buildRows.
   *  IDENTITY ONLY. It is unique per POSITION, which is what React and the
   *  roving tabindex need and what nothing else should use: five things once
   *  read it as a filesystem path and silently got `0:/Users/...`. */
  key: string;
  /** The folder's actual path, or null on "All" and the two shelf rows.
   *  Everything that means a PLACE uses this - expansion, the selection
   *  highlight, drop targets, the context menu, tag colours. */
  path: string | null;
  chain: LibraryCrumb[] | null;
  depth: number;
  name: string;
  hasChildren: boolean;
  /** The scan stopped short of this folder's contents. It is NOT a leaf,
   *  and drawing it as one is how a folder with things in it looked
   *  empty. LibraryView already prints the global note this row is
   *  about; the row itself said nothing. */
  deeper: boolean;
  expanded: boolean;
  /** Root rows only — the first video under the root, for the folder art. */
  artPath?: string | null;
  /** Set on the two CATEGORY rows. They were rendered outside this array with
   *  a hard-coded tabIndex={-1}, so the roving tabindex never reached them and
   *  neither did ↑/↓ - the Frames and web shelves had no keyboard route at
   *  all, and clicking was the only way in. One list is the truth again. */
  shelf?: "web" | "frames" | "sessions";
};

const KIND_CHIPS: Array<{ kind: LibraryKindFilter; label: string }> = [
  { kind: "all", label: "All" },
  { kind: "video", label: "Video" },
  { kind: "audio", label: "Audio" },
];

function buildRows(trees: LibraryFolder[], expanded: Set<string>): Row[] {
  const rows: Row[] = [
    { key: "all", path: null, chain: null, depth: 0, name: "All", hasChildren: false, deeper: false, expanded: false },
    // Directly under "All" because they are the same KIND of thing - a view
    // over everything of a category - rather than folders that happen to live
    // somewhere. Below the roots they would read as one more drive.
    { key: "shelf:web", path: null, chain: null, depth: 0, name: "From the web", hasChildren: false, deeper: false, expanded: false, shelf: "web" },
    { key: "shelf:frames", path: null, chain: null, depth: 0, name: "Frames", hasChildren: false, deeper: false, expanded: false, shelf: "frames" },
    // Sessions you have already held. The record was written all along
    // (~/Documents/Sauce Bunny/Screenings), and until now the only way to see
    // one was the shelf at the bottom of the co-review lobby.
    { key: "shelf:sessions", path: null, chain: null, depth: 0, name: "Review sessions", hasChildren: false, deeper: false, expanded: false, shelf: "sessions" },
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
      key: `${rootIdx}:${node.path}`, path: node.path, chain, depth, name: node.name,
      hasChildren: node.folders.length > 0, deeper: node.deeper, expanded: isExp,
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
  /* Roots open by default; ancestors of the current selection are revealed
     when the selection CHANGES. Persisted, because a deep library otherwise
     costs the same four expansions on every launch, and every other list
     preference in this app is remembered. */
  const stored = useMemo(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "null");
      if (Array.isArray(raw)) {
        return { set: new Set(raw.filter((p): p is string => typeof p === "string")), had: true };
      }
    } catch { /* a mangled value costs the expansions, not a crash */ }
    // `had` is the difference between "the user has never expressed a
    // preference" and "they have, and it says collapsed". Without it the
    // launch-time reveal below either never runs (so a fresh install cannot
    // see the folder it is inside) or always runs (so it undoes a collapse on
    // every launch). Both were tried.
    return { set: new Set<string>(), had: false };
  }, []);
  const [expanded, setExpanded] = useState<Set<string>>(stored.set);
  useEffect(() => {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch { /* quota */ }
  }, [expanded]);
  // Each root is default-opened only ONCE (on first appearance) — re-adding it
  // on every selection change would spring a manually-collapsed root back open.
  const seededRoots = useRef<Set<string>>(new Set());
  /** The selection this component last revealed, so a rescan is not
   *  mistaken for the user navigating somewhere. */
  const lastSelection = useRef<string | null>(null);
  useEffect(() => {
    // Which roots are new is decided BEFORE the updater, and the ref is
    // mutated here rather than inside it. A setState updater must be pure:
    // StrictMode runs it twice, and the second run would have found every root
    // already seeded and expanded none of them - so in dev a freshly added
    // root quietly failed to open.
    const fresh = trees.filter((t) => !seededRoots.current.has(t.path)).map((t) => t.path);
    for (const path of fresh) seededRoots.current.add(path);
    /* Reveal the way to the selection only when the selection has actually
       MOVED. This used to run on [trees, selection], and `trees` gets a fresh
       identity on every rescan - so collapsing the folder you were inside
       lasted until the next scan and then sprang back open. Roots were
       guarded against exactly this with seededRoots; the ancestor path was
       not. Navigating somewhere new still opens the way to it, which is the
       behaviour worth keeping. */
    const selKeyNow = selection ? selection.map((c) => c.path).join("\u0000") : "";
    /* The FIRST run never reveals. The persisted set already holds whatever
       was open when the app was last closed, so re-revealing the selection's
       ancestors on launch would undo a collapse the user had made
       deliberately - the one gesture this whole store exists to remember. */
    const first = lastSelection.current === null;
    const moved = (first ? !stored.had : selKeyNow !== lastSelection.current);
    lastSelection.current = selKeyNow;
    if (fresh.length === 0 && !moved) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of fresh) next.add(path);
      if (moved && selection) for (const c of selection) next.add(c.path);
      return next;
    });
  }, [trees, selection, stored.had]);

  const rows = useMemo(() => buildRows(trees, expanded), [trees, expanded]);
  const selKey = selection ? selection[selection.length - 1].path : "all";
  const [activeKey, setActiveKey] = useState<string>(selKey);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  /* Keep the roving stop valid as rows collapse/expand; follow the selection.
     A selected shelf keeps the roving stop, rather than the tree snapping the
     tab stop back to "All" behind the user.

     selKey is a PLAIN path and row.key is `<rootIndex>:<path>`, so this has to
     resolve one to the other. Assigning selKey straight into activeKey meant
     the `rows.some(r => r.key === activeKey)` check below never matched, and
     `active` fell back to "all" the moment a folder was selected: the roving
     tab stop left the folder you had just clicked, and every key the tree
     handles then acted on the "All" row instead. This is the same identity /
     path confusion that broke expansion, five rows further down the file. */
  useEffect(() => {
    if (shelf) { setActiveKey(`shelf:${shelf}`); return; }
    setActiveKey(rows.find((r) => r.path === selKey)?.key ?? "all");
  }, [selKey, shelf, rows]);
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
        if (row.hasChildren && !row.expanded && row.path) toggle(row.path);
        else if (row.hasChildren && rows[i + 1]) focusRow(rows[i + 1].key);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (row.hasChildren && row.expanded && row.path) toggle(row.path);
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
      /* The keyboard route to the folder's colour menu. It was pointer-only:
         onContextMenu and nothing else, so a folder's tags could not be
         reached from the keyboard at all (WCAG 2.1.1, Level A). Anchored to
         the focused row's own box, the way a context menu opened by keyboard
         is expected to appear next to what it acts on. */
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) break;
        if (!row.path || row.shelf) break;
        e.preventDefault();
        {
          const r = rowRefs.current.get(row.key)?.getBoundingClientRect();
          setMenu({
            path: row.path,
            x: (r?.left ?? 0) + 12,
            y: (r?.bottom ?? 0) - 4,
            isRoot: row.depth === 0,
          });
        }
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
    // r.path, NOT r.key. The key is `<rootIndex>:<path>`, so reading tags by
    // it asked the filesystem about "0:/Users/..." - a path that cannot exist.
    // read_finder_tags returned nothing for every folder, the catch swallowed
    // it, and every folder in the tree drew plain. Nothing was broken on
    // screen; the colours were simply never fetched. Filtering on path also
    // drops "All" and the two shelves, which have none, so the old key !==
    // "all" test is gone rather than restated.
    () => rows.map((r) => r.path).filter((p): p is string => p !== null),
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
          const isSel = row.shelf ? shelf === row.shelf : ((row.path ?? "all") === selKey && shelf === null);
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
                + (dropOver && dropOver === row.path ? " dropping" : "")}
              // A DROP TARGET, but only where a real directory is named.
              // "All" is an aggregate and the two shelf rows are views over a
              // category, so neither is a place a file can be put - and a
              // target that lights up and then refuses is worse than one that
              // never offered.
              data-drop={row.path && !row.shelf ? row.path : undefined}
              style={{ ["--depth" as string]: String(row.depth) }}
              /* A capped folder has contents this scan never reached, so the
                 row has to say why it will not open. Same wording as
                 unscannedDepthNote, which LibraryView prints for the tree as
                 a whole. */
              title={row.deeper
                ? `${row.name} goes deeper than this view scans. Add it as a library root to see inside.`
                : undefined}
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
                if (!row.path) return;
                setMenu({ path: row.path, x: e.clientX, y: e.clientY, isRoot: row.depth === 0 });
              }}
            >
              {row.hasChildren ? (
                <span
                  className={"cp-lib-tree-tw" + (row.expanded ? " open" : "")}
                  aria-hidden="true"
                  onClick={(e) => { e.stopPropagation(); if (row.path) toggle(row.path); }}
                >
                  <IconChevronRight size={13} />
                </span>
              ) : (
                <span
                  className={"cp-lib-tree-tw empty" + (row.deeper ? " deeper" : "")}
                  aria-hidden="true"
                >
                  {row.key === "all" ? <IconStack size={13} /> : null}
                  {row.shelf === "web" ? <IconLink size={13} /> : null}
                  {row.shelf === "frames" ? <IconCamera size={13} /> : null}
                  {row.shelf === "sessions" ? <IconReview size={13} /> : null}
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
                    const sw = primarySwatch(finderTags.tags.get(row.path ?? "") ?? []);
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
