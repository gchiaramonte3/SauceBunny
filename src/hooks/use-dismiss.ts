import { useEffect, type RefObject } from "react";

/**
 * Close a popover on a click outside it, or on Escape.
 *
 * Twenty-one components register their own document-level dismiss listener,
 * and they do not agree on how: seventeen on `mousedown`, three on
 * `pointerdown`, one on `pointerdown` in the capture phase. Escape splits
 * fifteen document-bubble, five document-capture, and several more that only
 * listen on the element, so Escape works there ONLY while focus is inside.
 *
 * Four answers to one question, and which one you get depends on which popover
 * you opened. That is the shape of a rule nobody wrote down, and it produced a
 * plain bug: HistoryPopover and InsightsPopover were written as siblings - the
 * second says so in its own header, and their outside-click handlers are byte
 * identical - but HistoryPopover has no Escape handler at all. Opening the
 * transcript history and pressing Escape did nothing.
 *
 * This is the one place to answer it. `mousedown` and document-bubble Escape,
 * because that is what the large majority already do.
 *
 * THE DEFERRED ATTACH IS LOAD-BEARING: the click that opens a popover is still
 * propagating when the effect runs, so attaching synchronously means the
 * opening click is also the closing click and the popover never appears. Every
 * hand-rolled copy has the same `setTimeout(..., 0)`, which is a good sign it
 * was learned the hard way at least once.
 */
/**
 * "A modal just opened over you; close." Fired by App when a KEYBOARD shortcut
 * opens the command palette or the shortcut sheet.
 *
 * Neither of the two dismissals above can see that. ⌘K produces no outside
 * mousedown and is not Escape, so a popover stayed open UNDERNEATH the palette
 * with its own ↑/↓/Enter listener still attached: arrowing the palette moved
 * the hidden list too, and one Enter loaded a recent video while the user was
 * looking at the palette. A keystroke landing on a surface the user cannot see
 * is the failure this closes.
 *
 * A window CustomEvent rather than shared state, matching
 * `saucebunny:speakers-changed` — the popovers own their own open flags and
 * App has no handle on them.
 */
export const DISMISS_POPOVERS = "saucebunny:dismiss-popovers";

export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    const onDismissAll = () => onClose();
    // Deferred so the click that opened this does not immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    window.addEventListener(DISMISS_POPOVERS, onDismissAll);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(DISMISS_POPOVERS, onDismissAll);
    };
  }, [ref, onClose, enabled]);
}
