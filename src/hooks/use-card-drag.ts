import { useCallback, useRef, useState } from "react";

/**
 * Drag cards onto a container to file them.
 *
 * WHY POINTER EVENTS AND NOT HTML5 DRAG-AND-DROP. The app needs Tauri's
 * `dragDropEnabled` (it defaults to on, and `DropTarget` is built on
 * `onDragDropEvent`) so that dropping a file from Finder imports it. That
 * installs an OS-level drag handler over the webview, and the interaction
 * between it and in-page `dataTransfer` drags is a platform detail we cannot
 * check from here without driving the packaged app by hand. Pointer events
 * do not go near the OS drag layer, behave identically in Chromium and
 * WKWebView, and are drivable in a test - and the marquee band next door is
 * already built this way, so this is the idiom the file wall already uses
 * rather than a second one.
 *
 * A PRESS IS NOT YET A DRAG. Nothing happens until the pointer travels past
 * a threshold, so an ordinary click still selects; past it, the click that
 * would have followed is swallowed, or every drag would also re-select the
 * card it started from and collapse the selection being dragged.
 */

export type CardDragState = {
  /** What is being dragged. */
  paths: readonly string[];
  /** Live pointer position, for the ghost. */
  x: number;
  y: number;
  /** The drop container under the pointer, or null over open space. */
  over: string | null;
  /**
   * Option held: this drop COPIES rather than moves.
   *
   * Apple: "Option-drag: Copy the dragged item. The pointer changes while you
   * drag the item." Read live rather than latched at pointerdown, because the
   * modifier can be pressed or released mid-drag and Finder's pointer follows
   * it - the decision belongs to the release, not the press.
   */
  copy: boolean;
};

const THRESHOLD_PX = 6;

export function useCardDrag({
  itemSelector, pathAttr = "data-path", targetSelector, targetAttr, pathsFor, onDrop,
}: {
  /** Matches a draggable card. */
  itemSelector: string;
  pathAttr?: string;
  /** Matches something a card can be dropped ON. */
  targetSelector: string;
  /** Attribute on the target holding its key (a folder path, a collection id). */
  targetAttr: string;
  /**
   * What this press should drag. Finder's rule: a card inside the selection
   * drags the whole selection, a card outside it drags only itself - which
   * is the same rule the batch verbs use, so one press cannot mean two
   * different sets depending on which control you reach for afterwards.
   */
  pathsFor: (path: string) => readonly string[];
  onDrop: (target: string, paths: readonly string[], opts: { copy: boolean }) => void;
}) {
  const [drag, setDrag] = useState<CardDragState | null>(null);
  const startRef = useRef<{ x: number; y: number; paths: readonly string[] } | null>(null);
  const draggingRef = useRef(false);
  /** Set on the pointerup that ended a drag; read and cleared by the click
   *  that the browser fires immediately afterwards. */
  const swallowClickRef = useRef(false);

  const reset = useCallback(() => {
    startRef.current = null;
    draggingRef.current = false;
    setDrag(null);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const card = e.target instanceof Element ? e.target.closest(itemSelector) : null;
    if (!card) return; // Open space: the band's press, not ours.
    const path = card.getAttribute(pathAttr);
    if (!path) return;
    // NOT preventDefault: this may still turn out to be a plain click, and
    // the card has to stay clickable and focusable.
    startRef.current = { x: e.clientX, y: e.clientY, paths: pathsFor(path) };
    draggingRef.current = false;
  }, [itemSelector, pathAttr, pathsFor]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const start = startRef.current;
    if (!start) return;
    if (!draggingRef.current) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD_PX) return;
      draggingRef.current = true;
      // CAPTURE, or the gesture cannot end. The handlers live on the pane, so
      // the moment the pointer leaves it the moves stop arriving and the
      // pointerup lands on some other element: the drag never finishes, the
      // ghost stays painted, and the click after it is swallowed by a gesture
      // that is still notionally running. Capture retargets every later
      // pointer event here, so releasing anywhere - over the nav rail, off
      // the window - still ends it. The marquee band next door does the same.
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); }
      catch { /* pointer already gone; pointerup/cancel still resets */ }
    }
    // elementFromPoint rather than the event target: once a drag is running
    // the pointer is over the ghost as often as the page, and the ghost must
    // never be what we hit-test against.
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under?.closest(targetSelector) ?? null;
    setDrag({
      paths: start.paths,
      x: e.clientX,
      y: e.clientY,
      over: target?.getAttribute(targetAttr) ?? null,
      copy: e.altKey,
    });
  }, [targetSelector, targetAttr]);

  const onPointerUp = useCallback(() => {
    const start = startRef.current;
    const wasDragging = draggingRef.current;
    const over = drag?.over ?? null;
    reset();
    if (!wasDragging || !start) return;
    swallowClickRef.current = true;
    if (over) onDrop(over, start.paths, { copy: drag?.copy ?? false });
  }, [drag, onDrop, reset]);

  const onPointerCancel = useCallback(() => {
    // Abandoned - a drag that ends nowhere files nothing.
    if (draggingRef.current) swallowClickRef.current = true;
    reset();
  }, [reset]);

  /** Put on the same element as the handlers, in the CAPTURE phase, so the
   *  click a finished drag would otherwise deliver to the card never lands. */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  return {
    drag,
    dragging: () => draggingRef.current,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
  };
}
