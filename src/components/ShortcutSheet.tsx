import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { shortcutSheetGroups, type KeybindingOverrides } from "../lib/keybindings";
import { useModalFocus } from "../hooks/use-modal-focus";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Live overrides — the sheet resolves bindings itself so rebinds show. */
  keybindings: KeybindingOverrides;
  /** Opens Settings → Commands (the editable keymap). */
  onCustomize: () => void;
};

/**
 * ⌘/ keyboard-shortcut cheat-sheet. Same modal mechanics as the command
 * palette (portal, shared scrim, Esc / outside-click close), but a read-only
 * multi-column reference instead of a runner. Groups come straight from the
 * rebindable registry (lib/keybindings.ts) so the sheet can never drift from
 * what the keys actually do; the trailing "Contextual" group lists the
 * hardcoded, non-rebindable interactions.
 */
export function ShortcutSheet({ open, onClose, keybindings, onCustomize }: Props) {
  const groups = useMemo(
    () => (open ? shortcutSheetGroups(keybindings) : []),
    [open, keybindings],
  );

  // Esc closes. Capture-phase so App's own keydown dispatch never sees it
  // (mirrors CommandPalette's listener).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Trap Tab inside the sheet + restore focus to the opener on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(open, dialogRef);

  if (!open) return null;

  return createPortal(
    <div
      className="cp-palette-scrim"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div className="cp-shortcuts" ref={dialogRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="cp-shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => { onClose(); onCustomize(); }}
            title="Re-bind any shortcut in Settings → Commands"
          >
            Customize…
          </button>
        </div>
        <div className="cp-shortcuts-grid">
          {groups.map((g) => (
            <section key={g.title} className="cp-shortcuts-group">
              <h3>
                {g.title}
                {g.title === "Contextual" && (
                  <span className="cp-shortcuts-ctx-tag">not rebindable</span>
                )}
              </h3>
              {g.rows.map((r) => (
                <div key={r.label} className="cp-shortcuts-row">
                  <span className="cp-shortcuts-label">
                    {r.label}
                    {r.note && <em className="cp-shortcuts-note">{r.note}</em>}
                  </span>
                  <kbd className="cp-shortcuts-keys">{r.keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="cp-palette-foot">
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
