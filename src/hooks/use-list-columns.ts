import { useEffect, useState } from "react";
import type React from "react";

/**
 * Resizable, persisted column widths for a list view.
 *
 * WRITTEN THREE TIMES BEFORE THIS EXISTED - in FrameListRows, WebListRows and
 * LibraryBrowserPane - near-verbatim, differing only in the column names and
 * the localStorage key. Same 48..240 bounds, same tolerant parse, same
 * mousemove/mouseup pair, same `cp-resizing-ew` body class. That is the
 * project's own "3+ components" bar for extracting a hook, met exactly.
 *
 * It is worth extracting rather than tolerating because the copies had already
 * started to drift in small ways (one hoisted the `raw as Record` cast, two
 * repeated it per field), and because the next list view would have made a
 * fourth copy that inherited whichever one it was pasted from.
 *
 * The bounds are deliberately NOT parameters. Three call sites agreed on
 * 48..240, and a column that can shrink to nothing or grow past the pane is a
 * worse list on any shelf, not a per-shelf choice.
 *
 * It also owns ORDER and VISIBILITY, so the three things a Finder column can
 * have done to it live together. They have to: the grid template, the header
 * cells and the row cells must agree about which columns exist and in what
 * sequence, and three components deriving that separately is how a hidden
 * column ends up with a visible width reserved for it.
 *
 * The stored shape grew from `{key: px}` to `{w, order, hidden}` and reads
 * the old one, because every existing install has widths saved under the flat
 * shape and discarding them to add a feature is a poor trade.
 */
const COL_MIN = 48;
const COL_MAX = 240;

/** What is persisted. v1 was the bare width map; it still parses. */
type Stored<K extends string> = {
  w?: Partial<Record<K, number>>;
  order?: K[];
  hidden?: K[];
};

export function useListColumns<K extends string>(
  storageKey: string,
  defaults: Readonly<Record<K, number>>,
  /** Grid tracks that come before the optional columns and are never hidden
   *  or reordered - the thumbnail well and the name. Finder does the same:
   *  Name cannot be turned off or moved out of first place. */
  leadingTracks = "34px minmax(0, 1fr)",
): {
  cols: Record<K, number>;
  /** Every optional column, in display order, including hidden ones. */
  order: K[];
  /** Order minus the hidden ones: what the grid and the cells must render. */
  visible: K[];
  isVisible: (key: K) => boolean;
  /** Show or hide a column. The last visible one cannot be hidden, because a
   *  list with only a name column has no menu affordance left to undo it. */
  toggleCol: (key: K) => void;
  /** Move `key` so it lands at `index` within the order. */
  moveCol: (key: K, index: number) => void;
  /** grid-template-columns for the header and every row, from one source. */
  template: string;
  /** The column being dragged, for the divider's active state. */
  dragCol: K | null;
  startColDrag: (key: K) => (e: React.MouseEvent) => void;
  /** Adjust one column by `delta` px, clamped the same way a drag is.
   *  The keyboard path for a control that was mouse-only. */
  nudgeCol: (key: K, delta: number) => void;
  /** The bounds, so a divider can report aria-valuemin / aria-valuemax
   *  without re-typing numbers this hook owns. */
  bounds: { min: number; max: number };
} {
  const keys = Object.keys(defaults) as K[];

  /* One read, one parse, three pieces of state. Split into three useStates
     with three lazy initialisers and the same JSON gets parsed three times on
     every mount, and the three can disagree about whether the value was
     usable. */
  const [state, setState] = useState<{ w: Record<K, number>; order: K[]; hidden: K[] }>(() => {
    const w = { ...defaults } as Record<K, number>;
    let order = [...keys];
    let hidden: K[] = [];
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (raw && typeof raw === "object") {
        const r = raw as Stored<K> & Record<string, unknown>;
        // v1 stored the widths at the top level. Read either shape.
        const widths = (r.w && typeof r.w === "object" ? r.w : r) as Record<string, unknown>;
        for (const k of keys) {
          const v = widths[k];
          // A stored width outside the bounds takes the default rather than
          // being clamped: it is a value this build would never have written,
          // so honouring it is guessing at intent.
          if (typeof v === "number" && v >= COL_MIN && v <= COL_MAX) w[k] = v;
        }
        if (Array.isArray(r.order)) {
          // Keep only known keys, then append any the stored order missed -
          // that is what happens when a build ADDS a column, and dropping it
          // would make the new column invisible with no way to get it back.
          const known = r.order.filter((k): k is K => keys.includes(k));
          order = [...new Set([...known, ...keys])];
        }
        if (Array.isArray(r.hidden)) {
          hidden = r.hidden.filter((k): k is K => keys.includes(k));
          // Never restore a state with nothing visible; see toggleCol.
          if (hidden.length >= keys.length) hidden = [];
        }
      }
    } catch { /* mangled value costs the defaults, not a crash */ }
    return { w, order, hidden };
  });

  const { w: cols, order, hidden } = state;

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ w: cols, order, hidden } satisfies Stored<K>));
    } catch { /* quota */ }
  }, [storageKey, cols, order, hidden]);

  const visible = order.filter((k) => !hidden.includes(k));
  const isVisible = (key: K) => !hidden.includes(key);

  const toggleCol = (key: K) => {
    setState((st) => {
      const on = st.hidden.includes(key);
      // Hiding the last visible column would leave a list with no header
      // cells, and the menu that would turn one back on is opened from a
      // header cell. Refuse rather than strand it.
      if (!on && st.hidden.length + 1 >= st.order.length) return st;
      return { ...st, hidden: on ? st.hidden.filter((k) => k !== key) : [...st.hidden, key] };
    });
  };

  const moveCol = (key: K, index: number) => {
    setState((st) => {
      const from = st.order.indexOf(key);
      if (from < 0) return st;
      const next = [...st.order];
      next.splice(from, 1);
      next.splice(Math.max(0, Math.min(next.length, index)), 0, key);
      return { ...st, order: next };
    });
  };

  const setCols = (fn: (c: Record<K, number>) => Record<K, number>) =>
    setState((st) => ({ ...st, w: fn(st.w) }));

  /* The ONE definition of the track list. The header and every row read it,
     so a hidden column cannot leave its width reserved and a reorder cannot
     move the header without the cells. */
  const template = [leadingTracks, ...visible.map((k) => `${cols[k]}px`)].join(" ");


  const [dragCol, setDragCol] = useState<K | null>(null);

  const startColDrag = (key: K) => (e: React.MouseEvent) => {
    e.preventDefault();
    // The row underneath is selectable and draggable; without this a grab on
    // the divider starts a selection or a card drag instead of a resize.
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

  /**
   * THE KEYBOARD PATH. Column resizing was mouse-only in all three copies of
   * this before it was extracted: `ColDivider` is a span with `onMouseDown`
   * and nothing else - no tabIndex, no key handler - so the width could not be
   * changed by keyboard at all (WCAG 2.1.1, Level A).
   *
   * It shares the clamp with the drag rather than repeating it, which is the
   * point of putting it here: two code paths that each round and bound a value
   * their own way drift, and then the keyboard stops at a different width than
   * the mouse does.
   */
  const nudgeCol = (key: K, delta: number) => {
    setCols((c) => ({ ...c, [key]: Math.max(COL_MIN, Math.min(COL_MAX, c[key] + delta)) }));
  };

  return {
    cols, order, visible, isVisible, toggleCol, moveCol, template,
    dragCol, startColDrag, nudgeCol, bounds: { min: COL_MIN, max: COL_MAX },
  };
}
