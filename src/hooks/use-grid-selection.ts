import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clickSelect, EMPTY_SELECTION, pruneSelection, selectAll, selectedInOrder,
  type SelectionState,
} from "../lib/library-selection";
import { marqueeSelection } from "../lib/marquee";

/**
 * Finder-rules selection over a wall of cards, for any shelf that has one.
 *
 * The Library's folder pane grew shift-click, ⌘-click and a lasso band; the
 * web shelf and the frames shelf did not, so the same wall of cards behaved
 * differently depending on which room you were standing in. The rules
 * themselves were never the problem - `library-selection.ts` and
 * `use-marquee.ts` are both already generic - what was missing was that
 * every shelf had to re-assemble the same six pieces of state around them,
 * and only one shelf ever did.
 *
 * This is that assembly, once. It is extracted at three call sites, which is
 * the bar this project sets for a hook.
 *
 * `paths` MUST be the list in display order: ranges run over what the user
 * can see, so a shift-click after re-sorting selects the span on screen
 * rather than a span of the underlying scan.
 */
export function useGridSelection(paths: readonly string[]) {
  const [sel, setSel] = useState<SelectionState>(EMPTY_SELECTION);

  // The live list, for handlers that must not be re-created on every render
  // (the card click handler is passed to hundreds of cards).
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  /** The selection as it was when the current band started; null when idle. */
  const dragBaseRef = useRef<ReadonlySet<string> | null>(null);

  // A path that has left the list - a delete, a folder change, a filter -
  // must leave the selection too, or a batch runs against something that is
  // no longer on screen.
  useEffect(() => { setSel((cur) => pruneSelection(cur, paths)); }, [paths]);

  const onItemClick = useCallback((path: string, e: { shiftKey: boolean; metaKey: boolean }) => {
    // metaKey only. On macOS Ctrl+click is the right-click convention, not a
    // ⌘ synonym, and treating it as one fights the context menu.
    setSel((cur) => clickSelect(cur, pathsRef.current, path, {
      shift: e.shiftKey, meta: e.metaKey,
    }));
  }, []);

  const onMarquee = useCallback((hit: string[], mods: { shift: boolean; meta: boolean }) => {
    // The ref write happens HERE, not inside the updater. An updater must be
    // pure - React may run it more than once and StrictMode does so
    // deliberately - and a ref written in there makes the base set depend on
    // which invocation React kept.
    const base = dragBaseRef.current;
    if (base == null) {
      // First move of this drag: whatever is selected right now is the base.
      setSel((cur) => {
        dragBaseRef.current ??= cur.selected;
        return { selected: marqueeSelection(cur.selected, hit, mods), anchor: hit[0] ?? cur.anchor };
      });
      return;
    }
    // The band answers against the selection as it was when the drag STARTED,
    // so sweeping back and forth keeps producing the same answer instead of
    // accumulating everything the band ever crossed.
    setSel((cur) => ({
      selected: marqueeSelection(base, hit, mods),
      anchor: hit[0] ?? cur.anchor,
    }));
  }, []);

  const onMarqueeEnd = useCallback(() => { dragBaseRef.current = null; }, []);

  const clear = useCallback(() => setSel(EMPTY_SELECTION), []);
  const all = useCallback(() => setSel(selectAll(pathsRef.current)), []);

  /** The selection in DISPLAY order, which is the order a batch runs in. */
  const selectedPaths = useMemo(() => selectedInOrder(sel, paths), [sel, paths]);

  return {
    sel, setSel,
    selected: sel.selected,
    selectedPaths,
    onItemClick,
    onMarquee,
    onMarqueeEnd,
    clear,
    selectAll: all,
  };
}
