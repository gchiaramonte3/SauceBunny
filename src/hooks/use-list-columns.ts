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
 */
const COL_MIN = 48;
const COL_MAX = 240;

export function useListColumns<K extends string>(
  storageKey: string,
  defaults: Readonly<Record<K, number>>,
): {
  cols: Record<K, number>;
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
  const [cols, setCols] = useState<Record<K, number>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        const out = { ...defaults } as Record<K, number>;
        for (const k of Object.keys(defaults) as K[]) {
          const v = r[k];
          // A stored width outside the bounds takes the default rather than
          // being clamped: it is a value this build would never have written,
          // so honouring it is guessing at intent.
          if (typeof v === "number" && v >= COL_MIN && v <= COL_MAX) out[k] = v;
        }
        return out;
      }
    } catch { /* mangled value costs the defaults, not a crash */ }
    return { ...defaults } as Record<K, number>;
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(cols)); } catch { /* quota */ }
  }, [storageKey, cols]);

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

  return { cols, dragCol, startColDrag, nudgeCol, bounds: { min: COL_MIN, max: COL_MAX } };
}
