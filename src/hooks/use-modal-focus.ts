import { useEffect, type RefObject } from "react";

/**
 * Modal focus management, shared by the app's dialogs (SettingsModal,
 * CommandPalette, ShortcutSheet, MediaInfoModal):
 *
 *   - On open: remember what had focus, then focus the dialog container
 *     (callers put `tabIndex={-1}` on it) unless something inside the
 *     dialog already grabbed focus (e.g. the palette's autofocused input).
 *   - While open: trap Tab / Shift-Tab inside the dialog so keyboard
 *     focus can't wander into the inert page behind the scrim.
 *   - On close/unmount: restore focus to the element that opened it.
 *
 * Esc-to-close stays in each component — they already own that listener.
 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(open: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      root.focus();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const el = ref.current;
      if (!el) return;
      const nodes = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((n) => n.offsetParent !== null);
      if (nodes.length === 0) { e.preventDefault(); return; }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && el.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) { e.preventDefault(); last.focus(); }
      } else {
        if (!inside || active === last) { e.preventDefault(); first.focus(); }
      }
    }
    // Capture phase so the trap wins over App's global key dispatch.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (prev && prev.isConnected) prev.focus();
    };
  }, [open, ref]);
}
