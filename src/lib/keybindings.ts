/**
 * Editable keyboard shortcuts.
 *
 * The canonical action list + (de)serialization for key combos. App.tsx
 * dispatches keystrokes by matching the live event's combo to an action;
 * Settings → Commands renders this list as an editable table. User overrides
 * persist in localStorage; an action with no override falls back to its
 * `defaults`. This is the single source of truth for what each key does — the
 * registry's cosmetic `hotkey` strings (lib/commands.ts) are overlaid from here
 * so the palette + settings never drift from the real bindings.
 */

import { loadJson, saveJson } from "./storage";

export type KeyActionId =
  | "play.toggle" | "play.back5" | "play.fwd5"
  | "play.frameBack" | "play.frameFwd" | "play.secondBack" | "play.secondFwd"
  | "play.toStart" | "play.toEnd"
  | "mark.in" | "mark.out" | "mark.clear" | "mark.gotoIn" | "mark.gotoOut"
  | "review.rangeIn" | "review.rangeOut"
  | "src.fetch" | "export.clip" | "queue.add" | "queue.toggle"
  | "view.logs" | "app.settings" | "app.palette";

export type KeyActionGroup = "Transport" | "Marking" | "Source & export" | "View" | "App";

export type KeyAction = {
  id: KeyActionId;
  label: string;
  group: KeyActionGroup;
  /** One or more default combos in serialized form (e.g. "mod+k", "shift+left", "j"). */
  defaults: string[];
  /**
   * When true the shortcut fires even while a text field is focused or Settings
   * is open — the ⌘-combos that are universal escape hatches. Transport/marking
   * keys are false so typing in the URL bar never scrubs the video.
   */
  global: boolean;
};

/** Order here drives both the editor layout and combo-map precedence. */
export const KEY_ACTIONS: KeyAction[] = [
  { id: "play.toggle",     label: "Play / pause",          group: "Transport", defaults: ["space", "k"],            global: false },
  // NLE J-K-L transport (the ids keep their historical "back5"/"fwd5" names so
  // stored user bindings survive; each press walks the 1-2-4-8× shuttle ladder,
  // and with K held it frame-steps instead — see lib/shuttle.ts).
  { id: "play.back5",      label: "Shuttle / step back (J)",    group: "Transport", defaults: ["j"],                global: false },
  { id: "play.fwd5",       label: "Shuttle / step forward (L)", group: "Transport", defaults: ["l"],                global: false },
  { id: "play.frameBack",  label: "Step 1 frame back",     group: "Transport", defaults: [",", "left"],             global: false },
  { id: "play.frameFwd",   label: "Step 1 frame forward",  group: "Transport", defaults: [".", "right"],            global: false },
  { id: "play.secondBack", label: "Step 1 second back",    group: "Transport", defaults: ["shift+left", "shift+,"], global: false },
  { id: "play.secondFwd",  label: "Step 1 second forward", group: "Transport", defaults: ["shift+right", "shift+."],global: false },
  { id: "play.toStart",    label: "Jump to start",         group: "Transport", defaults: ["home"],                  global: false },
  { id: "play.toEnd",      label: "Jump to end",           group: "Transport", defaults: ["end"],                   global: false },
  { id: "mark.in",         label: "Mark in",               group: "Marking",   defaults: ["i"],                     global: false },
  { id: "mark.out",        label: "Mark out",              group: "Marking",   defaults: ["o"],                     global: false },
  { id: "mark.clear",      label: "Clear marks",           group: "Marking",   defaults: ["g"],                     global: false },
  { id: "mark.gotoIn",     label: "Go to mark in",         group: "Marking",   defaults: ["q"],                     global: false },
  { id: "mark.gotoOut",    label: "Go to mark out",        group: "Marking",   defaults: ["w"],                     global: false },
  // Review comment-range marks — the ⇧-flavored twins of I/O. Bare I/O set the
  // orange clip-export marks; these set the reviewer-tinted span the NEXT
  // review comment attaches to. Only live while the Review tab is in front.
  { id: "review.rangeIn",  label: "Comment range: mark in",  group: "Marking", defaults: ["shift+i"],               global: false },
  { id: "review.rangeOut", label: "Comment range: mark out", group: "Marking", defaults: ["shift+o"],               global: false },
  { id: "src.fetch",       label: "Fetch URL",             group: "Source & export", defaults: ["mod+enter"],       global: true },
  { id: "export.clip",     label: "Export clip",           group: "Source & export", defaults: ["alt+e"],           global: false },
  { id: "queue.add",       label: "Add selection to queue",group: "Source & export", defaults: ["mod+shift+a"],     global: true },
  { id: "queue.toggle",    label: "Toggle queue panel",    group: "View",      defaults: ["mod+shift+q"],           global: true },
  { id: "view.logs",       label: "Toggle pipeline log",   group: "View",      defaults: ["mod+\\"],                global: true },
  { id: "app.settings",    label: "Open / close settings", group: "App",       defaults: ["mod+,"],                 global: true },
  { id: "app.palette",     label: "Command palette",       group: "App",       defaults: ["mod+k"],                 global: true },
];

export const KEY_ACTION_BY_ID: Record<KeyActionId, KeyAction> =
  Object.fromEntries(KEY_ACTIONS.map((a) => [a.id, a])) as Record<KeyActionId, KeyAction>;

export const KEYBINDINGS_STORAGE_KEY = "saucebunny.keybindings.v1";

/** Overrides only: actionId → combos. Absent id → use the action's defaults. */
export type KeybindingOverrides = Partial<Record<KeyActionId, string[]>>;

export function loadKeybindings(): KeybindingOverrides {
  return loadJson<KeybindingOverrides>(KEYBINDINGS_STORAGE_KEY, {});
}
export function saveKeybindings(o: KeybindingOverrides): void {
  saveJson(KEYBINDINGS_STORAGE_KEY, o);
}

/** Resolved combos for an action: its override if present, else the defaults. */
export function bindingsFor(id: KeyActionId, overrides: KeybindingOverrides): string[] {
  return overrides[id] ?? KEY_ACTION_BY_ID[id].defaults;
}

/** Map every resolved combo → the action it triggers. Earlier actions win ties. */
export function buildComboMap(overrides: KeybindingOverrides): Map<string, KeyActionId> {
  const m = new Map<string, KeyActionId>();
  for (const a of KEY_ACTIONS) {
    for (const combo of bindingsFor(a.id, overrides)) {
      if (!m.has(combo)) m.set(combo, a.id);
    }
  }
  return m;
}

/**
 * Set `combo` as the only binding for `id`, stealing it from any other action
 * that currently uses it so a combo always triggers exactly one action. Returns
 * the next overrides (does not persist) + which action it was stolen from.
 */
export function assignBinding(
  overrides: KeybindingOverrides, id: KeyActionId, combo: string,
): { next: KeybindingOverrides; stolenFrom: KeyActionId | null } {
  const next: KeybindingOverrides = { ...overrides };
  let stolenFrom: KeyActionId | null = null;
  for (const a of KEY_ACTIONS) {
    if (a.id === id) continue;
    const current = bindingsFor(a.id, next);
    if (current.includes(combo)) {
      stolenFrom = a.id;
      next[a.id] = current.filter((c) => c !== combo); // may end up [] until reset
    }
  }
  next[id] = [combo];
  return { next, stolenFrom };
}

/** Drop the override for `id` so it returns to its defaults. */
export function resetBinding(overrides: KeybindingOverrides, id: KeyActionId): KeybindingOverrides {
  const next = { ...overrides };
  delete next[id];
  return next;
}

// ── Event → combo serialization ──────────────────────────────────────────────

type Keyish = { code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

/**
 * The physical key as a stable token, derived from `e.code` so Shift/CapsLock/
 * keyboard-layout never change it (Shift+',' still reads "comma"). Returns null
 * for modifier-only presses and keys we don't bind.
 */
function keyToken(code: string, key: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  switch (code) {
    case "Space": return "space";
    case "Comma": return ",";
    case "Period": return ".";
    case "Slash": return "/";
    case "Backslash": return "\\";
    case "Semicolon": return ";";
    case "Quote": return "'";
    case "BracketLeft": return "[";
    case "BracketRight": return "]";
    case "Minus": return "-";
    case "Equal": return "=";
    case "Backquote": return "`";
    case "Enter": case "NumpadEnter": return "enter";
    case "Escape": return "escape";
    case "Backspace": return "backspace";
    case "Delete": case "ForwardDelete": return "delete";
    case "Tab": return "tab";
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "Home": return "home";
    case "End": return "end";
    case "PageUp": return "pageup";
    case "PageDown": return "pagedown";
    default:
      // Some layouts report a printable single-char key with an empty/odd code.
      return key && key.length === 1 ? key.toLowerCase() : null;
  }
}

/** Serialize a keydown event to a canonical combo, or null for modifier-only keys. */
export function eventToCombo(e: Keyish): string | null {
  const token = keyToken(e.code, e.key);
  if (!token) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(token);
  return parts.join("+");
}

const SYMBOL: Record<string, string> = {
  mod: "⌘", alt: "⌥", shift: "⇧", ctrl: "⌃",
  space: "Space", enter: "↩", escape: "Esc", backspace: "⌫", delete: "⌦", tab: "⇥",
  left: "←", right: "→", up: "↑", down: "↓",
  home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
};

/** Pretty mac-style display for a combo. "mod+shift+a" → "⌘⇧A". */
export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => SYMBOL[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("");
}

/** Display all resolved bindings for an action, e.g. "Space / K" or "—" if unbound. */
export function formatBindings(combos: string[]): string {
  return combos.length ? combos.map(formatCombo).join(" / ") : "—";
}
