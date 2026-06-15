import { useEffect, useState } from "react";
import {
  KEY_ACTIONS, KEY_ACTION_BY_ID, bindingsFor, assignBinding, resetBinding,
  eventToCombo, formatCombo,
  type KeyActionId, type KeyActionGroup, type KeybindingOverrides,
} from "../lib/keybindings";

const GROUP_ORDER: KeyActionGroup[] = ["Transport", "Marking", "Source & export", "View", "App"];

/**
 * Editable keyboard-shortcut table (Settings → Commands). Each action shows its
 * resolved binding chip(s); "Record" captures the next keystroke and assigns it
 * (stealing it from any other action so a combo always maps to exactly one);
 * "Reset" restores that action's default. Pure UI over the keybindings helpers —
 * persistence + dispatch live in App via the overrides it emits through onChange.
 */
export function KeybindingEditor({
  overrides,
  onChange,
}: {
  overrides: KeybindingOverrides;
  onChange: (next: KeybindingOverrides) => void;
}) {
  const [capturing, setCapturing] = useState<KeyActionId | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // While capturing, grab the next keystroke on the CAPTURE phase and
  // stopPropagation so App's global keydown handler doesn't also fire — recording
  // ⌘K must not open the palette. Esc cancels; modifier-only presses keep waiting.
  useEffect(() => {
    if (!capturing) return;
    const id = capturing; // narrow once for the closure below
    function onCapture(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      const combo = eventToCombo(e);
      if (!combo) return; // modifier-only — wait for the real key
      const { next, stolenFrom } = assignBinding(overrides, id, combo);
      onChange(next);
      setNote(stolenFrom
        ? `${formatCombo(combo)} was reassigned from “${KEY_ACTION_BY_ID[stolenFrom].label}”.`
        : null);
      setCapturing(null);
    }
    window.addEventListener("keydown", onCapture, true);
    return () => window.removeEventListener("keydown", onCapture, true);
  }, [capturing, overrides, onChange]);

  return (
    <div className="cp-keybinds">
      {GROUP_ORDER.map((group) => (
        <div className="cp-keybind-group" key={group}>
          <div className="cp-keybind-group-title">{group}</div>
          {KEY_ACTIONS.filter((a) => a.group === group).map((a) => {
            const combos = bindingsFor(a.id, overrides);
            const overridden = overrides[a.id] !== undefined;
            const isCapturing = capturing === a.id;
            return (
              <div className={"cp-keybind-row" + (isCapturing ? " capturing" : "")} key={a.id}>
                <span className="cp-keybind-label">{a.label}</span>
                <div className="cp-keybind-keys">
                  {isCapturing ? (
                    <span className="cp-keybind-capture">Press a key… <span className="hint">Esc cancels</span></span>
                  ) : combos.length ? (
                    combos.map((c) => <kbd key={c} className="cp-keybind-chip">{formatCombo(c)}</kbd>)
                  ) : (
                    <span className="cp-keybind-unbound">Unassigned</span>
                  )}
                </div>
                <div className="cp-keybind-actions">
                  <button
                    className="btn btn-ghost btn-compact"
                    onClick={() => { setNote(null); setCapturing(a.id); }}
                    disabled={isCapturing}
                  >
                    {isCapturing ? "Recording…" : "Record"}
                  </button>
                  {overridden && (
                    <button
                      className="btn btn-ghost btn-compact"
                      onClick={() => onChange(resetBinding(overrides, a.id))}
                      title="Restore the default binding"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {note && <div className="cp-keybind-note">{note}</div>}
      <div className="cp-keybind-foot">
        <button className="btn btn-ghost btn-compact" onClick={() => { setNote(null); onChange({}); }}>
          Reset all shortcuts
        </button>
      </div>
    </div>
  );
}
