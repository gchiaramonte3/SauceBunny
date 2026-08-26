import { useCallback, useEffect, useRef } from "react";

/**
 * WAI-ARIA roving tabindex over a wall of cards or rows, with the keyboard a
 * Finder window actually has: arrows in two dimensions, Home/End, and
 * type-ahead.
 *
 * WHY IT IS DOM-DRIVEN. The same choice `LibraryRow` made and for the same
 * reason: the children are heterogeneous (poster cards, list rows) and mount
 * and unmount constantly as scans land, searches narrow and thumbnails
 * resolve. Querying the container beats threading an index prop through every
 * card, and it means the grid and the list share one implementation.
 *
 * THE POINT OF A ROVING TABINDEX is that the whole wall is ONE Tab stop. Before
 * this, Tab walked every card in the Library one at a time — hundreds of stops
 * to get past a folder — which is precisely the thing the pattern exists to
 * prevent.
 *
 * Note this only works because the transport keys were given a view gate: the
 * arrow keys were bound to frame-step and Home/End to seek, so they never
 * reached the Library at all.
 */
export function useRovingGrid(opts: {
  /** The scroll container holding the items. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** CSS selector for the focusable item elements, in DOM order. */
  itemSelector: string;
  /** Item names in the SAME order, for type-ahead. */
  names: readonly string[];
  /** `grid` makes up/down move by a row; `list` makes them move by one. */
  layout: "grid" | "list";
  /**
   * The keyboard moved to `index`. Finder moves the SELECTION with the arrow
   * keys, not just a focus ring — "arrow keys move the selection itself" — and
   * Shift extends it. This hook only knows about elements and indices, so the
   * caller maps the index to a path and applies its own selection rule.
   *
   * Not called for type-ahead, which in Finder jumps the selection too, so
   * that is reported the same way.
   */
  onNavigate?: (index: number, mods: { shift: boolean; meta: boolean }) => void;
}) {
  const { containerRef, itemSelector, names, layout, onNavigate } = opts;
  const activeRef = useRef(0);
  const typeBufRef = useRef("");
  const typeAtRef = useRef(0);

  const items = useCallback(
    () => Array.from(containerRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []),
    [containerRef, itemSelector],
  );

  const setActive = useCallback((list: HTMLElement[], idx: number) => {
    activeRef.current = idx;
    for (let i = 0; i < list.length; i += 1) {
      const want = i === idx ? "0" : "-1";
      // Compare the ATTRIBUTE, not the property. A <button> reports
      // `tabIndex === 0` with no attribute set, so a property compare skips
      // the write for the active item and leaves the roving stop invisible to
      // CSS, to devtools and to any test asserting the contract.
      //
      // Only touching the DOM on a real change still matters: this runs on
      // every commit, and blind writes across hundreds of nodes are how a
      // scroll turns into a layout thrash.
      if (list[i].getAttribute("tabindex") !== want) list[i].setAttribute("tabindex", want);
    }
  }, []);

  // Exactly one tabbable item after every commit. Items come and go as the
  // filter, sort and scan change, so there is no dependency that reliably
  // describes "the set changed" — but the write-only-on-change guard above
  // makes running it every time cheap.
  useEffect(() => {
    const list = items();
    if (list.length === 0) return;
    if (activeRef.current >= list.length) activeRef.current = list.length - 1;
    setActive(list, activeRef.current);
  });

  /**
   * How many items sit on the first visual row.
   *
   * Read from layout rather than from the CSS, because the grid is
   * `minmax(140px, 1fr)` and reflows with the window — any constant here would
   * be wrong at most widths. Items on the same row share an offsetTop.
   */
  const columns = useCallback((list: HTMLElement[]): number => {
    if (layout === "list" || list.length === 0) return 1;
    const top = list[0].offsetTop;
    let n = 0;
    while (n < list.length && list[n].offsetTop === top) n += 1;
    return Math.max(1, n);
  }, [layout]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const list = items();
    if (list.length === 0) return;
    const cur = list.indexOf(document.activeElement as HTMLElement);

    // ── Type-ahead ──────────────────────────────────────────────────
    // A printable character with no modifier jumps to the next name starting
    // with what you have typed. Finder's oldest trick and the fastest way to
    // reach a known clip in a folder of two hundred.
    if (
      e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey
      && e.key !== " "  // Space is select/preview, not a search character
    ) {
      const now = Date.now();
      // A pause ends the word. 700ms is long enough to type "in" without
      // racing and short enough that a later "t" means "t", not "int".
      typeBufRef.current = now - typeAtRef.current > 700 ? e.key : typeBufRef.current + e.key;
      typeAtRef.current = now;
      const needle = typeBufRef.current.toLowerCase();
      // Search from just after the current item so repeating one letter walks
      // through every match, which is the behaviour people rely on.
      const from = cur >= 0 ? cur : 0;
      const order = typeBufRef.current.length === 1
        ? [...list.keys()].map((i) => (from + 1 + i) % list.length)
        : [...list.keys()];
      const hit = order.find((i) => names[i]?.toLowerCase().startsWith(needle));
      if (hit != null) {
        e.preventDefault();
        setActive(list, hit);
        list[hit].focus();
        onNavigate?.(hit, { shift: false, meta: false });
      }
      return;
    }

    const cols = columns(list);
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":  next = Math.max(0, (cur < 0 ? 0 : cur) - 1); break;
      case "ArrowRight": next = Math.min(list.length - 1, (cur < 0 ? -1 : cur) + 1); break;
      // Clamp to the last item rather than refusing: a short final row should
      // still be reachable with one Down from anywhere above it.
      case "ArrowDown":  next = Math.min(list.length - 1, (cur < 0 ? -cols : cur) + cols); break;
      case "ArrowUp":    next = Math.max(0, (cur < 0 ? 0 : cur) - cols); break;
      case "Home":       next = 0; break;
      case "End":        next = list.length - 1; break;
      default: return;
    }
    e.preventDefault();
    setActive(list, next);
    list[next].focus(); // the browser scrolls it into view
    // Shift extends, a bare arrow replaces — the caller decides what that
    // means against its own selection state.
    onNavigate?.(next, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  }, [items, names, columns, setActive, onNavigate]);

  /** Clicking or tabbing onto an item adopts it as the roving stop. */
  const onFocusCapture = useCallback((e: React.FocusEvent) => {
    const list = items();
    const i = list.indexOf(e.target as HTMLElement);
    if (i >= 0 && i !== activeRef.current) setActive(list, i);
  }, [items, setActive]);

  return { onKeyDown, onFocusCapture };
}
