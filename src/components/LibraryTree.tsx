import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevronRight, IconPanelLeft, IconPlus, IconRefresh, IconStack, IconFolderSolid } from "./Icons";
import type { LibraryFolder } from "../types";
import { libraryPosterPaths, type LibraryCrumb, type LibraryKindFilter } from "../lib/library";

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
};

type Row = {
  /** "all" or the folder's absolute path. */
  key: string;
  chain: LibraryCrumb[] | null;
  depth: number;
  name: string;
  hasChildren: boolean;
  expanded: boolean;
  /** Root rows only — the first video under the root, for the folder art. */
  artPath?: string | null;
};

const KIND_CHIPS: Array<{ kind: LibraryKindFilter; label: string }> = [
  { kind: "all", label: "All" },
  { kind: "video", label: "Video" },
  { kind: "audio", label: "Audio" },
];

function buildRows(trees: LibraryFolder[], expanded: Set<string>): Row[] {
  const rows: Row[] = [
    { key: "all", chain: null, depth: 0, name: "All", hasChildren: false, expanded: false },
  ];
  const walk = (node: LibraryFolder, chain: LibraryCrumb[], depth: number) => {
    const isExp = expanded.has(node.path);
    rows.push({
      key: node.path, chain, depth, name: node.name,
      hasChildren: node.folders.length > 0, expanded: isExp,
      // Roots carry small folder art (first video's poster, BFS) — the
      // Spotify library-row read. Subfolders stay text rows.
      artPath: depth === 0 ? (libraryPosterPaths(node, 1)[0] ?? null) : undefined,
    });
    if (isExp) {
      for (const sub of node.folders) {
        walk(sub, [...chain, { name: sub.name, path: sub.path }], depth + 1);
      }
    }
  };
  for (const t of trees) walk(t, [{ name: t.name, path: t.path }], 0);
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
  addFolder, rescanAll, scanning,
}: Props) {
  // Roots open by default; ancestors of the current selection are auto-revealed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Each root is default-opened only ONCE (on first appearance) — re-adding it
  // on every selection change would spring a manually-collapsed root back open.
  const seededRoots = useRef<Set<string>>(new Set());
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const t of trees) {
        if (!seededRoots.current.has(t.path)) { seededRoots.current.add(t.path); next.add(t.path); }
      }
      if (selection) for (const c of selection) next.add(c.path);
      return next;
    });
  }, [trees, selection]);

  const rows = useMemo(() => buildRows(trees, expanded), [trees, expanded]);
  const selKey = selection ? selection[selection.length - 1].path : "all";
  const [activeKey, setActiveKey] = useState<string>(selKey);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Keep the roving stop valid as rows collapse/expand; follow the selection.
  useEffect(() => { setActiveKey(selKey); }, [selKey]);
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
      case "Enter": case " ": e.preventDefault(); onSelect(row.chain); break;
    }
  };

  return (
    <div className="cp-lib-tree">
      <div className="cp-lib-tree-head">
        <h2 className="cp-lib-tree-title">Library</h2>
        <button
          type="button"
          className="cp-lib-tree-collapse"
          title="Hide folders"
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
          const isSel = row.key === selKey;
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
              className={"cp-lib-tree-row" + (isSel ? " selected" : "")}
              style={{ ["--depth" as string]: String(row.depth) }}
              onClick={() => { setActiveKey(row.key); onSelect(row.chain); }}
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
                </span>
              )}
              {row.key !== "all" && (
                <IconFolderSolid size={15} className="cp-lib-tree-folder" />
              )}
              <span className="cp-lib-tree-name">{row.name}</span>
            </button>
          );
        })}
      </div>
      <div className="cp-lib-tree-foot">
        <button type="button" className="btn btn-primary btn-compact" onClick={() => void addFolder()}>
          <IconPlus size={12} /> Add folder
        </button>
        <button
          type="button"
          className={"btn-icon cp-lib-tree-rescan" + (scanning ? " scanning" : "")}
          title={scanning ? "Scanning…" : "Rescan library"}
          aria-label="Rescan library"
          onClick={rescanAll}
          disabled={scanning}
        >
          <IconRefresh size={13} />
        </button>
      </div>
    </div>
  );
}
