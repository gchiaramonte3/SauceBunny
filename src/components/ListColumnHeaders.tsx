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
 *   · Name is not one of the movable `specs`: it cannot be hidden and cannot
 *     be moved out of first place, which is also true in Finder. It IS
 *     resizable, via NameHeader below - that was the one of the three Finder
 *     properties this got wrong, and it was wrong because Name's width lived
 *     in a string literal with no number to change.
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

/**
 * The Name column's header, and the divider that finally makes it resizable.
 *
 * ONE component rather than the same lines pasted into three list views. The
 * library, the cached-web shelf and the frames shelf each rendered their own
 * bare `<SortHeader label="Name">`, and that duplication is precisely why Name
 * had no divider in any of them: a fix would have had to be made three times
 * and was made none.
 *
 * Name is still not reorderable and still cannot be hidden, which matches
 * Finder. Resizable is the only one of the three it was wrong about.
 */
export function NameHeader({ sort, dir, onSort, model }: {
  sort: LibrarySortKey;
  dir: LibrarySortDir;
  onSort: (key: LibrarySortKey) => void;
  model: {
    nameWidth: number | null;
    dragName: boolean;
    startNameDrag: (e: React.MouseEvent) => void;
    nudgeName: (delta: number, host?: HTMLElement | null) => void;
    resetName: () => void;
    nameBounds: { min: number; max: number };
  };
}) {
  return (
    <SortHeader className="cp-lib-lrow-name" label="Name" col="name" sort={sort} dir={dir} onSort={onSort}>
      <ColDivider
        onDown={model.startNameDrag}
        active={model.dragName}
        label="Name"
        // undefined while the column sizes to the pane: there is no width to
        // report, and reporting a made-up one would be worse than silence.
        value={model.nameWidth ?? undefined}
        min={model.nameBounds.min}
        max={model.nameBounds.max}
        onNudge={(d, host) => model.nudgeName(d, host)}
        onReset={model.resetName}
      />
    </SortHeader>
  );
}

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
  /** The live gesture. A ref, not state: it is read inside window listeners
   *  that must see the current value, not the one closed over at mousedown. */
  const dragRef = useRef<{ key: K; x: number; moved: boolean } | null>(null);
  /** A drag ends with a click on the same cell. Without this the drop also
   *  re-sorts the list, which is not what the hand asked for. */
  const swallowClick = useRef(false);

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
        /* POINTER events, deliberately not HTML5 drag-and-drop.
           Two reasons, and the first one is a bug the user hit.

           On macOS, setting `draggable` and starting a drag opens a real
           NSDragging session. Tauri's webview drag-drop listener - the one
           DropTarget uses for FILE imports - sees that session enter the
           webview and cannot tell it from a Finder drag, so grabbing a column
           header raised the full-window "drop a video, audio or SRT file"
           card. Nothing was wrong with DropTarget; the header was making the
           OS announce a drag. No HTML5 drag, no announcement.

           Second, it is simply the better gesture here. A native drag paints a
           translucent snapshot the app cannot style, commits on the OS's hit
           test rather than ours, and gives no control over the threshold - so
           a 2px wobble while clicking to sort became a reorder. Pointer events
           give a real threshold, our own insertion line, and a drop we resolve
           ourselves. Finder's own column reorder behaves this way: the header
           moves with the pointer, the others part around it. */
        const beginMove = (e: React.PointerEvent) => {
          // Left button only, and never when the gesture started on the
          // divider: that strip owns resizing and a resize must not reorder.
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest(".cp-lib-coldiv")) return;
          dragRef.current = { key, x: e.clientX, moved: false };

          const colAt = (x: number, y: number): K | null => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            const cell = el?.closest("[data-colkey]") as HTMLElement | null;
            return (cell?.dataset.colkey as K | undefined) ?? null;
          };
          const onMove = (ev: PointerEvent) => {
            const st = dragRef.current;
            if (!st) return;
            // The threshold is what keeps click-to-sort working. Below it this
            // is still a click and nothing has visibly happened.
            if (!st.moved) {
              if (Math.abs(ev.clientX - st.x) < 4) return;
              st.moved = true;
              setMoving(st.key);
            }
            const over = colAt(ev.clientX, ev.clientY);
            setOverIdx(over ? model.visible.indexOf(over) : null);
          };
          const finish = (ev: PointerEvent | null) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
            const st = dragRef.current;
            dragRef.current = null;
            // ev === null is the cancel path: commit nothing, just let go.
            if (ev && st?.moved) {
              const over = colAt(ev.clientX, ev.clientY);
              if (over && over !== st.key) model.moveCol(st.key, model.order.indexOf(over));
              swallowClick.current = true;
            }
            setMoving(null);
            setOverIdx(null);
          };
          const onUp = (ev: PointerEvent) => finish(ev);
          /* pointercancel is not paranoia. The OS takes the pointer away for
             things that happen mid-drag in a desktop app - a touchpad gesture
             claiming the sequence, the window losing the capture - and then
             pointerup never arrives. Without this the listeners stay on
             window, `moving` stays set, and the header keeps a column ghosted
             at 0.55 opacity with an insertion line that follows nothing, until
             the view remounts. A gesture must have exactly one exit. */
          const onCancel = () => finish(null);
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onCancel);
        };

        const dragProps = {
          "data-colkey": key,
          onPointerDown: beginMove,
          onClickCapture: (e: React.MouseEvent) => {
            if (!swallowClick.current) return;
            swallowClick.current = false;
            e.preventDefault();
            e.stopPropagation();
          },
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
