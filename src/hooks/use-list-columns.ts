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
/* Name gets its own bounds. COL_MAX is 240, which is a sensible ceiling for
   "Size" and a silly one for a filename: the library is full of names like
   `Ex-Oil-Engineer-Turned-Climate-Whistleblower_-We-Face-COLLAPSE...mp4`, and
   a column that cannot pass 240px can never show one. The floor matches the
   auto-mode floor so the column behaves the same whichever mode it is in. */
const NAME_MIN = 150;
const NAME_MAX = 900;

/** What is persisted. v1 was the bare width map; it still parses. */
type Stored<K extends string> = {
  w?: Partial<Record<K, number>>;
  order?: K[];
  hidden?: K[];
  /** The Name column's explicit width, or absent for "size to the pane".
   *  Absent is the default and the state every install starts in. */
  name?: number | null;
};

export function useListColumns<K extends string>(
  storageKey: string,
  defaults: Readonly<Record<K, number>>,
  /** Grid tracks that come before the optional columns and are never hidden
   *  or reordered - the thumbnail well and the name. Finder does the same:
   *  Name cannot be turned off or moved out of first place. */
  /* The Name track has a FLOOR, and that floor is the whole difference
     between this feeling like Finder and feeling broken.
     It was `minmax(0, 1fr)`. Zero means the flexible column absorbs every
     pixel the fixed columns take, all the way down to nothing - so widening
     Size on the right made the FILENAME on the left shrink and vanish. The
     hand expects the column it is dragging to change and its neighbours to
     move; instead the far side of the table quietly evaporated. That is the
     "stretches and expands weirdly" complaint, and it is a one-value bug.
     With a floor the name stops shrinking and the grid overflows instead.
     That is deliberate and it is what Finder does: `.cp-lib-pane` sets
     overflow-y, which per CSS makes overflow-x compute to auto, and the
     header renders inside that same scroller - so the columns scroll together
     rather than the header sliding out of register with its rows. */
  /* Only the ART well is a caller's business now. The name track used to be
     baked into this string, which is exactly why Name could not be resized:
     a literal `minmax(150px, 1fr)` has no width to change. The hook builds it
     from state instead. */
  artTrack = "34px",
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
  /** 1-based index of the LAST REAL column's track, which is not always the
   *  last track: an explicit Name width appends a filler track to absorb the
   *  slack, and the table's trailing line belongs on the last column, not on
   *  the pane's edge. */
  lastColumnTrack: number;
  /** How many tracks `template` declares. Cannot be recovered by splitting
   *  the string: `minmax(0, 1fr)` contains a space, so a naive split counts
   *  one track as three. The column rules need it to draw one cell per
   *  track, so it is published rather than re-derived. */
  trackCount: number;
  /** The column being dragged, for the divider's active state. */
  dragCol: K | null;
  startColDrag: (key: K) => (e: React.MouseEvent) => void;
  /** Adjust one column by `delta` px, clamped the same way a drag is.
   *  The keyboard path for a control that was mouse-only. */
  nudgeCol: (key: K, delta: number) => void;
  /** The bounds, so a divider can report aria-valuemin / aria-valuemax
   *  without re-typing numbers this hook owns. */
  bounds: { min: number; max: number };
  /** The Name column's explicit width, or null while it sizes to the pane. */
  nameWidth: number | null;
  dragName: boolean;
  /** Grab the divider on Name's right edge. Takes the event so it can measure
   *  what the browser is currently giving the column - in auto mode there is
   *  no stored width to start the drag from, and starting from a guess makes
   *  the column jump under the pointer on the first pixel of movement. */
  startNameDrag: (e: React.MouseEvent) => void;
  /** `host` is the header cell, so the keyboard path can measure a column
   *  that has no stored width yet. Optional: a caller that knows the width
   *  does not need it. */
  nudgeName: (delta: number, host?: HTMLElement | null) => void;
  /** Back to sizing with the pane. Finder resets a column on a double-click
   *  of its divider, and without a way back an explicit width is a one-way
   *  door. */
  resetName: () => void;
  nameBounds: { min: number; max: number };
} {
  const keys = Object.keys(defaults) as K[];

  /* One read, one parse, three pieces of state. Split into three useStates
     with three lazy initialisers and the same JSON gets parsed three times on
     every mount, and the three can disagree about whether the value was
     usable. */
  const [state, setState] = useState<{ w: Record<K, number>; order: K[]; hidden: K[]; name: number | null }>(() => {
    const w = { ...defaults } as Record<K, number>;
    let order = [...keys];
    let hidden: K[] = [];
    let name: number | null = null;
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
        // Same rule as the column widths: a value this build would not have
        // written is treated as absent rather than clamped into range.
        if (typeof r.name === "number" && r.name >= NAME_MIN && r.name <= NAME_MAX) name = r.name;
      }
    } catch { /* mangled value costs the defaults, not a crash */ }
    return { w, order, hidden, name };
  });

  const { w: cols, order, hidden, name: nameWidth } = state;

  /* RECONCILE WHEN THE SET OF COLUMNS CHANGES AT RUNTIME.
     The lazy initialiser above merges stored state with `defaults` ONCE, at
     mount. Nothing re-ran when `defaults` gained or lost a key afterwards,
     and a commit in this repo claimed the hook "already handles" that case.
     It did not, and both halves failed silently:
       - a column ADDED at runtime never entered `order`, so it never rendered
         and "New Column..." appeared to do nothing at all;
       - a column REMOVED at runtime stayed in `order`, so the header dropped
         its cell (no spec to draw) while `template` kept emitting its width -
         an invisible track that shoved every column after it sideways.
     Keyed on the joined key list, not on `defaults`, so an unmemoised caller
     does not re-run this every render. The width lookups are done here rather
     than inside the updater so the updater stays pure. */
  const keySig = keys.join("\u0000");
  useEffect(() => {
    const known = new Set<string>(keys);
    const addedWidths = keys.map((k) => [k, defaults[k]] as const);
    setState((st) => {
      const added = addedWidths.filter(([k]) => !(k in st.w));
      const removed = (Object.keys(st.w) as K[]).filter((k) => !known.has(k));
      if (added.length === 0 && removed.length === 0) return st;
      const w = { ...st.w } as Record<K, number>;
      for (const k of removed) delete w[k];
      for (const [k, width] of added) w[k] = width;
      return {
        ...st,
        w,
        order: [...st.order.filter((k) => known.has(k)), ...added.map(([k]) => k)],
        hidden: st.hidden.filter((k) => known.has(k)),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the key SET on purpose; see above
  }, [keySig]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ w: cols, order, hidden, name: nameWidth } satisfies Stored<K>));
    } catch { /* quota */ }
  }, [storageKey, cols, order, hidden, nameWidth]);

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
  const nameTrack = nameWidth == null ? `minmax(${NAME_MIN}px, 1fr)` : `${nameWidth}px`;
  const tracks = [artTrack, nameTrack, ...visible.map((k) => `${cols[k]}px`)];
  /* With an explicit Name width, NO track flexes any more - so without this
     the row would stop wherever the columns happen to end and leave a bare
     strip down the right of the pane where the hover and selection fills do
     not reach.
     This USED to append a trailing filler track. The slack went somewhere the
     table had no column for, so the row fill, the zebra stripe and the header
     underline all ran a whole track further right than the table's own
     right-hand line: measured, a 350px gap with Name at 400px, against 28px
     (exactly the row's padding) with Name flexible. What that looks like is a
     vertical line floating in open space to the left of where the rows end,
     reported as "the position line is not where it should be".
     The LAST REAL column takes the slack instead, which is what Finder does.
     Its minimum stays the width the user set, so the pane still scrolls
     sideways rather than squashing when it is too narrow, and the table now
     ends where its rows end. With no columns besides Name, Name itself is the
     last track and takes it. */
  if (nameWidth != null) {
    const last = tracks.length - 1;
    const lastKey = visible[visible.length - 1];
    const lastW = last === 1 ? nameWidth : cols[lastKey];
    tracks[last] = `minmax(${lastW}px, 1fr)`;
  }
  const template = tracks.join(" ");
  const trackCount = tracks.length;
  // art + name + the visible columns. Equal to `tracks.length` now that no
  // filler is appended, and kept as its own expression because it means
  // something different: the track that carries the table's trailing line.
  const lastColumnTrack = 2 + visible.length;


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

  const [dragName, setDragName] = useState(false);

  /**
   * Resize Name itself, which Finder allows and this did not.
   *
   * Name was the flexible track with its width written into a literal, so
   * there was no number to change and no divider to grab: it could only be
   * resized INDIRECTLY, by making some other column wider and letting Name
   * absorb the loss. That is backwards, and it is why dragging Size felt like
   * it was resizing the wrong column.
   *
   * The start width is MEASURED rather than assumed. In auto mode there is no
   * stored width, so beginning the drag from a constant would snap the column
   * to that constant on the first pixel of movement - a jump under the
   * pointer, which is the specific thing that makes a resize feel broken.
   */
  const startNameDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const host = (e.currentTarget as HTMLElement).parentElement;
    const startW = nameWidth ?? (host ? Math.round(host.getBoundingClientRect().width) : NAME_MIN);
    const startX = e.clientX;
    setDragName(true);
    document.body.classList.add("cp-resizing-ew");
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(NAME_MIN, Math.min(NAME_MAX, startW + (ev.clientX - startX)));
      setState((st) => ({ ...st, name: next }));
    };
    const onUp = () => {
      setDragName(false);
      document.body.classList.remove("cp-resizing-ew");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  /** The keyboard path, and it measures for the same reason the drag does: an
   *  arrow key pressed while Name is sizing to the pane must nudge the width
   *  the user can SEE, not collapse a 600px column to the floor. */
  const nudgeName = (delta: number, host?: HTMLElement | null) => {
    const base = nameWidth ?? (host ? Math.round(host.getBoundingClientRect().width) : NAME_MIN);
    const next = Math.max(NAME_MIN, Math.min(NAME_MAX, base + delta));
    setState((st) => ({ ...st, name: next }));
  };

  const resetName = () => setState((st) => ({ ...st, name: null }));

  return {
    cols, order, visible, isVisible, toggleCol, moveCol, template, trackCount, lastColumnTrack,
    dragCol, startColDrag, nudgeCol, bounds: { min: COL_MIN, max: COL_MAX },
    nameWidth, dragName, startNameDrag, nudgeName, resetName,
    nameBounds: { min: NAME_MIN, max: NAME_MAX },
  };
}
