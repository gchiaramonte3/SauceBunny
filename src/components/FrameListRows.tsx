import { useEffect, useState } from "react";
import { formatBytes } from "../lib/library";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { formatFrameTimecode, type FrameItem } from "../lib/frames";
import { assetUrl } from "../lib/asset-url";
import { ColDivider, SortHeader } from "./LibraryBrowserPane";
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
const COL_MIN = 48;
const COL_MAX = 240;
const COL_DEFAULT = { source: 120, size: 84, date: 96 };

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

export function FrameListRows({ items, sort, dir, onSort, onDelete, onOpenFrame }: {
  items: readonly FrameItem[];
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
  onDelete: (path: string) => void;
  onOpenFrame: (path: string) => void;
}) {
  const [cols, setCols] = useState<{ source: number; size: number; date: number }>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLS_KEY) ?? "null");
      if (raw && typeof raw === "object") {
        const pick = (v: unknown, d: number) =>
          typeof v === "number" && v >= COL_MIN && v <= COL_MAX ? v : d;
        const r = raw as Record<string, unknown>;
        return {
          source: pick(r.source, COL_DEFAULT.source),
          size: pick(r.size, COL_DEFAULT.size),
          date: pick(r.date, COL_DEFAULT.date),
        };
      }
    } catch { /* mangled value costs the defaults, not a crash */ }
    return COL_DEFAULT;
  });
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch { /* quota */ }
  }, [cols]);
  const [dragCol, setDragCol] = useState<null | keyof typeof COL_DEFAULT>(null);
  const startColDrag = (key: keyof typeof COL_DEFAULT) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = cols[key];
    setDragCol(key);
    document.body.classList.add("cp-resizing-ew");
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(COL_MIN, Math.min(COL_MAX, startW + (ev.clientX - startX)));
      setCols((c) => ({ ...c, [key]: next }));
    };
    const onUp = () => {
      setDragCol(null);
      document.body.classList.remove("cp-resizing-ew");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="cp-lib-list"
      role="list"
      aria-label="Grabbed frames"
      style={{
        ["--col-kind" as string]: `${cols.source}px`,
        ["--col-size" as string]: `${cols.size}px`,
        ["--col-date" as string]: `${cols.date}px`,
      }}
    >
      <div className="cp-lib-list-head">
        <span className="cp-lib-lrow-art" aria-hidden="true" />
        <SortHeader className="cp-lib-lrow-name" label="Name" col="name" sort={sort} dir={dir} onSort={onSort}>
          <ColDivider onDown={startColDrag("source")} active={dragCol === "source"} />
        </SortHeader>
        {/* Source has no sort key of its own - the shelves already group by
            it, so a Source sort would duplicate the grouping. */}
        <span className="cp-lib-lrow-kind">
          Source
          <ColDivider onDown={startColDrag("size")} active={dragCol === "size"} />
        </span>
        <SortHeader className="cp-lib-lrow-size" label="Size" col="size" sort={sort} dir={dir} onSort={onSort}>
          <ColDivider onDown={startColDrag("date")} active={dragCol === "date"} />
        </SortHeader>
        <SortHeader className="cp-lib-lrow-date" label="Grabbed" col="date" sort={sort} dir={dir} onSort={onSort} />
      </div>
      {items.map((it) => {
        const tc = formatFrameTimecode(it.timecode);
        return (
          <div key={it.path} role="listitem" className="cp-web-lrow-wrap">
            <button
              type="button"
              className="cp-lib-lrow"
              title={it.path}
              onClick={() => onOpenFrame(it.path)}
            >
              <span className="cp-lib-lrow-art">
                <img src={assetUrl(it.path)} alt="" loading="lazy" />
              </span>
              <span className="cp-lib-lrow-name">
                {it.name}
                {tc && <span className="cp-web-lrow-dur">{tc}</span>}
              </span>
              <span className="cp-lib-lrow-kind">{it.source}</span>
              <span className="cp-lib-lrow-size">{formatBytes(it.size_bytes)}</span>
              <span className="cp-lib-lrow-date">{grabbedLabel(it.created_at)}</span>
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
    </div>
  );
}
