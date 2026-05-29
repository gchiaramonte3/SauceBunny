/**
 * Single source of truth for every action the app exposes.
 *
 * - The toolbar binds the most-common 4-6 actions to bevelled buttons.
 * - The keyboard handler in App.tsx binds the most-common shortcuts.
 * - The ⌘K command palette enumerates ALL of them with fuzzy search.
 * - The Settings → Shortcuts tab renders this same list as documentation.
 *
 * The intent: any new action gets one entry here and shows up in three
 * places at once with no further wiring. Keeps the toolbar tight while
 * making every capability discoverable.
 */

export type CommandGroup =
  | "Source"
  | "Playback"
  | "Marks"
  | "Export"
  | "Queue"
  | "Transcript"
  | "View"
  | "App";

export type Command = {
  /** Stable id — used for React keys + future MRU ranking. */
  id: string;
  /** Short, human-readable verb phrase ("Export clip", "Mark in"). */
  label: string;
  /** Bucket header in the palette + settings list. */
  group: CommandGroup;
  /** Optional one-line hint shown below the label. */
  description?: string;
  /**
   * Display string for the keyboard shortcut (e.g. "⌘K", "⇧I"). Pure
   * cosmetic — the actual key binding lives in the keyboard handler.
   * Kept here so the palette and settings list don't drift from the
   * real bindings.
   */
  hotkey?: string;
  /**
   * Extra search terms not visible in the label. E.g. "Toggle queue"
   * might list `["clips", "drawer"]` so a search for "clips" still hits.
   */
  keywords?: string[];
  /** When true, the row renders dimmed and the run handler is skipped. */
  disabled?: boolean;
  /** Side-effecting handler invoked on Enter / click. */
  run: () => void;
};

/**
 * Fuzzy-ish matcher tuned for command-palette use. Not as good as
 * Fuse.js but zero dependencies and good enough for ~25 commands.
 *
 * Score is the sum of:
 *  - exact-substring hit in label  (10)
 *  - exact-substring hit in keywords/group/description (5 each)
 *  - per-char in-order match in label (1 each, +2 if at word start)
 * Higher = better. Returns 0 (filtered out) when no chars match at all.
 */
export function scoreCommand(cmd: Command, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1; // empty query → show all, neutral order
  const label = cmd.label.toLowerCase();
  const haystack = `${label} ${cmd.group.toLowerCase()} ${(cmd.keywords ?? []).join(" ").toLowerCase()} ${(cmd.description ?? "").toLowerCase()}`;

  let score = 0;
  if (label.includes(q)) score += 10;
  if (haystack.includes(q)) score += 5;

  // Per-char in-order match against the label.
  let qi = 0;
  let prevWasSeparator = true;
  for (let i = 0; i < label.length && qi < q.length; i++) {
    const ch = label[i];
    if (ch === q[qi]) {
      score += prevWasSeparator ? 3 : 1;
      qi++;
    }
    prevWasSeparator = ch === " " || ch === "-" || ch === "_";
  }
  if (qi < q.length) return 0; // not all query chars matched in order
  return score;
}
