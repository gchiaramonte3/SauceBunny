import { useRef, useState } from "react";
import type React from "react";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { ColDivider, SortHeader } from "./LibraryBrowserPane";
import type { LibrarySortDir, LibrarySortKey } from "../lib/library";
import { IconCheck } from "./Icons";

/**
 * The optional column headers of a list view: sortable, resizable,
 * reorderable by drag, and hideable from a right-click menu. Finder's list
 * header, in the three places this app has one (library, web, frames).
 *
 * It exists because the three lists had hand-written header rows whose cell
 * ORDER was hardcoded in the JSX and whose track widths were hardcoded in the
 * stylesheet. Neither can stay literal once a column can move or disappear:
 * the grid template, the header cells and the row cells have to agree about
 * which columns exist and in what sequence, and three components deriving
 * that separately is how a hidden column keeps its reserved width.
 *
 * Two deliberate departures from what was here before:
 *
 *   · A divider now sits on the RIGHT edge of the column it resizes, so
 *     dragging right widens that column and everything after it shifts
 *     right. It used to sit on the right edge of the PREVIOUS cell and
 *     resize the NEXT one, which meant a rightward drag widened the column
 *     to the right of the grab point - the opposite of Finder, and the
 *     opposite of what the hand expects.
 *
 *   · Name is not in here. It is the 1fr track, it cannot be hidden and it
 *     cannot be moved out of first place, which is also true in Finder.
 */

export type ColSpec<K extends string> = {
  key: K;
  /** The header's visible text, and the name in the show/hide menu. */
  label: string;
  /** The class that positions this cell, e.g. "cp-lib-lrow-size". */
  className: string;
  /** The sort this column drives. Omitted for a column that does not sort. */
  sort?: LibrarySortKey;
};

/** The parts of useListColumns this needs. Named so a caller cannot pass a
 *  half-built object and have it type-check. */
export type ColumnModel<K extends string> = {
  cols: Record<K, number>;
  order: K[];
  visible: K[];
  isVisible: (key: K) => boolean;
  toggleCol: (key: K) => void;
  moveCol: (key: K, index: number) => void;
  dragCol: K | null;
  startColDrag: (key: K) => (e: React.MouseEvent) => void;
  nudgeCol: (key: K, delta: number) => void;
  bounds: { min: number; max: number };
};

export function ListColumnHeaders<K extends string>({
  specs, model, sort, dir, onSort,
}: {
  specs: readonly ColSpec<K>[];
  model: ColumnModel<K>;
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** The column being dragged to a new position, and where it would land. */
  const [moving, setMoving] = useState<K | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const byKey = new Map(specs.map((s) => [s.key, s]));

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      {model.visible.map((key, i) => {
        const spec = byKey.get(key);
        if (!spec) return null;
        const isMoving = moving === key;
        const cls =
          spec.className +
          " cp-lib-colhead" +
          (isMoving ? " is-moving" : "") +
          (overIdx === i && moving && moving !== key ? " is-drop" : "");
        const inner = (
          <ColDivider
            onDown={model.startColDrag(key)}
            active={model.dragCol === key}
            label={spec.label}
            value={model.cols[key]}
            min={model.bounds.min}
            max={model.bounds.max}
            onNudge={(d) => model.nudgeCol(key, d)}
          />
        );
        /* draggable on the cell, not on an inner handle: Finder lets you grab
           the header anywhere. The divider stops its own mousedown, so a
           resize never starts a move. */
        const dragProps = {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            setMoving(key);
            e.dataTransfer.effectAllowed = "move";
            // Firefox will not start a drag without payload; the value is
            // never read, the component state carries the key.
            e.dataTransfer.setData("text/plain", key);
          },
          onDragOver: (e: React.DragEvent) => {
            if (!moving) return;
            e.preventDefault();
            setOverIdx(i);
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            if (moving && moving !== key) model.moveCol(moving, model.order.indexOf(key));
            setMoving(null);
            setOverIdx(null);
          },
          onDragEnd: () => { setMoving(null); setOverIdx(null); },
          onContextMenu: openMenu,
        };

        /* SortHeader, not a hand-rolled button: it already owns the caret
           and, more importantly, aria-sort - which a reimplementation here
           quietly dropped. */
        return spec.sort ? (
          <SortHeader
            key={key}
            className={spec.className}
            label={spec.label}
            col={spec.sort}
            sort={sort}
            dir={dir}
            onSort={onSort}
            cellProps={{ ...dragProps, className: cls.replace(spec.className, "").trim(), title: `Sort by ${spec.label}. Drag to reorder, right-click for columns.` }}
          >
            {inner}
          </SortHeader>
        ) : (
          <span key={key} className={cls} title="Drag to reorder, right-click for columns." {...dragProps}>
            {spec.label}
            {inner}
          </span>
        );
      })}
      {menuAt && (
        <ColumnMenu
          at={menuAt}
          specs={specs}
          model={model}
          onClose={() => setMenuAt(null)}
        />
      )}
    </>
  );
}

/**
 * The right-click menu on a column header: one checkable row per column.
 *
 * Modelled on Finder's, including that the checks are the state rather than
 * an action list - you are looking at which columns are on, not choosing a
 * command. It stays open across toggles, because turning three columns off
 * one at a time through three right-clicks is not a menu, it is a chore.
 */
function ColumnMenu<K extends string>({ at, specs, model, onClose }: {
  at: { x: number; y: number };
  specs: readonly ColSpec<K>[];
  model: ColumnModel<K>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  useMenuKeys(ref, true, onClose);

  const byKey = new Map(specs.map((s) => [s.key, s]));
  // The order the user arranged them in, not the order they were declared.
  const rows = model.order.map((k) => byKey.get(k)).filter((s): s is ColSpec<K> => !!s);
  const lastOne = model.visible.length <= 1;

  return (
    <div
      ref={ref}
      className="cp-colmenu"
      role="menu"
      aria-label="Columns"
      style={{ left: at.x, top: at.y }}
    >
      {rows.map((s) => {
        const on = model.isVisible(s.key);
        return (
          <button
            key={s.key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            /* The last visible column cannot be turned off: this menu is
               reached FROM a header cell, so a list with none is stranded. */
            disabled={on && lastOne}
            className="cp-colmenu-item"
            onClick={() => model.toggleCol(s.key)}
          >
            <span className="cp-colmenu-check" aria-hidden>{on ? <IconCheck size={11} /> : null}</span>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
