import { useEffect, useRef, type RefObject } from "react";

/**
 * Light-dismiss for popovers and dropdown menus: pressing outside or Escape
 * closes. Shared by the toolbar/transport popovers (VolumeControl,
 * SpeedControl, ViewOptions, NotificationBell, RecentSources, CoReviewPopover,
 * EmojiPicker), the transcript popovers (Insights/History/Rename) and menus
 * (download, tools), AiSummary's download menu, and ReviewPanel's three menus.
 *
 * `insideRefs` are the elements a press should NOT dismiss through — the
 * popover itself plus, when it's portaled away from its trigger, the trigger
 * too (so the trigger's own click stays a true toggle).
 *
 * This hook replaced ~13 hand-rolled copies that had drifted. The reconciled
 * behavior, and which variant won:
 *
 *   - `pointerdown`, not `mousedown` (CoReviewPopover's variant): it fires
 *     for pen/touch as well and at the earliest moment of the press, so a
 *     popover can never linger through the start of another interaction.
 *     Triggers that swallow the press instead of being listed in
 *     `insideRefs` must swallow `onPointerDown`, not `onMouseDown`
 *     (see the Insights button in TranscriptViewer).
 *   - Listeners attach one tick AFTER open (the transcript popovers'
 *     variant): a popover mounted in response to a press can have its mount
 *     effect flushed while that same event is still dispatching, and a
 *     document listener added mid-dispatch fires for the very press that
 *     opened it — instant self-close. The deferral is unobservable for the
 *     toggle-button popovers (no human presses outside within the same tick).
 *   - Escape always dismisses, and the callback is told why. Most callers
 *     ignore `reason`; EmojiPicker keeps its search text on an accidental
 *     outside press but clears it on a deliberate Escape.
 *
 * Deliberately NOT migrated: SpeakerColorPicker (capture-phase listeners and
 * a stop-propagated Escape so it wins over whatever popover it's layered on)
 * and the modals (scrim semantics; focus handling lives in use-modal-focus).
 */
export type DismissReason = "outside" | "escape";

export function usePopoverDismiss(
  open: boolean,
  insideRefs: ReadonlyArray<RefObject<HTMLElement | null>>,
  onDismiss: (reason: DismissReason) => void,
) {
  // Callers pass array literals and inline closures — mirror them in refs so
  // the listeners bind once per open instead of on every render.
  const refsRef = useRef(insideRefs);
  refsRef.current = insideRefs;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (refsRef.current.some((r) => r.current?.contains(t))) return;
      dismissRef.current("outside");
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismissRef.current("escape");
    }
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
}
