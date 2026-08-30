import { useEffect, useRef, type RefObject } from "react";

/**
 * The ARIA menu keyboard model, once, for every `role="menu"` in the app.
 *
 * WHY THIS EXISTS. Eleven menus were built as `role="menu"` containing
 * `role="menuitem"` buttons, and two of them handled an arrow key. That
 * combination is not a small omission: `role="menu"` is a PROMISE. A screen
 * reader that meets one switches its user into menu navigation and tells them
 * to use the arrow keys, so a menu that only answers Tab has advertised a
 * keyboard model it does not implement. Plain buttons in a plain container
 * would have been more accessible than the role, which is the tell that the
 * role was decoration.
 *
 * The pattern, from the ARIA Authoring Practices menu button:
 *
 *   - Opening moves focus INTO the menu, onto the checked item if there is one
 *     (a radio menu should open on the current value, not on the top) else the
 *     first enabled item.
 *   - Up / Down move between items and WRAP. Disabled items are skipped rather
 *     than focused-and-inert.
 *   - Home / End jump to the ends.
 *   - Typing a letter jumps to the next item starting with it, wrapping. Worth
 *     the twenty lines here: the transcript Tools menu has ten items.
 *   - Escape closes.
 *   - Tab closes and lets focus move on, because a menu is ONE tab stop. This
 *     is the part that looks like a regression and is not: internal Tab
 *     navigation is exactly what the menu role replaces.
 *   - Closing returns focus to whatever opened it, so the keyboard does not
 *     restart from the top of the document.
 *
 * ROVING TABINDEX. Every item is given `tabIndex = -1` and focus is moved
 * programmatically. Native buttons are focusable by default, so without this a
 * menu would put ten stops in the page's tab order - the thing the role exists
 * to prevent.
 *
 * Deliberately NOT coupled to `useDismiss`: only two of the ten menu
 * components use it, the rest have hand-rolled dismissers that predate it, and
 * this needs to work the same in both. Calling `onClose` twice is harmless.
 */

/** Items in DOM order. Re-queried per keystroke so a menu whose contents
 *  change (the transcript Tools menu grows an entry when a source is loaded)
 *  is never navigated from a stale list. */
function itemsOf(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'),
  ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
}

export function useMenuKeys(
  menuRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  /** What had focus when the menu opened, so closing can hand it back. */
  const returnTo = useRef<HTMLElement | null>(null);
  /** Type-ahead buffer, cleared after a pause so "de" then later "l" are two
   *  searches rather than one for "del". */
  const typed = useRef("");
  const typedAt = useRef(0);

  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;

    // Never adopt <body>. Focusing it later is pointless, and treating it as a
    // real target hides the case where nothing had focus when the menu opened.
    const opener = document.activeElement as HTMLElement | null;
    returnTo.current = opener && opener !== document.body ? opener : null;

    const items = itemsOf(menu);
    for (const el of items) el.tabIndex = -1;
    // The checked item, so a radio menu opens on the current value.
    const checked = items.find((el) => el.getAttribute("aria-checked") === "true");
    (checked ?? items[0])?.focus();

    function move(delta: number) {
      const list = itemsOf(menu as HTMLElement);
      if (list.length === 0) return;
      for (const el of list) el.tabIndex = -1;
      const at = list.indexOf(document.activeElement as HTMLElement);
      // -1 (focus is on the menu itself, or on something removed) starts from
      // the top going down and the bottom going up, rather than nowhere.
      const next = at < 0
        ? (delta > 0 ? 0 : list.length - 1)
        : (at + delta + list.length) % list.length;
      list[next]?.focus();
    }

    function edge(first: boolean) {
      const list = itemsOf(menu as HTMLElement);
      if (list.length === 0) return;
      for (const el of list) el.tabIndex = -1;
      (first ? list[0] : list[list.length - 1]).focus();
    }

    function jumpTo(prefix: string) {
      const list = itemsOf(menu as HTMLElement);
      const at = list.indexOf(document.activeElement as HTMLElement);
      // Search FORWARD from the current item and wrap, so repeating a letter
      // cycles through the items that share it.
      for (let i = 1; i <= list.length; i += 1) {
        const el = list[(at + i + list.length) % list.length];
        if ((el.textContent ?? "").trim().toLowerCase().startsWith(prefix)) { el.focus(); return; }
      }
    }

    function onKey(e: KeyboardEvent) {
      switch (e.key) {
        // BOTH AXES, deliberately. A vertical menu wants Up/Down and a
        // horizontal one - the two emoji pickers are single rows - wants
        // Left/Right, and honouring only the axis that matches
        // aria-orientation means the "wrong" arrow does nothing, which reads
        // as the menu having stopped responding. Accepting either is
        // forgiving and costs nothing; aria-orientation still tells a screen
        // reader which pair to suggest.
        case "ArrowDown": case "ArrowRight": e.preventDefault(); move(1); return;
        case "ArrowUp": case "ArrowLeft": e.preventDefault(); move(-1); return;
        case "Home": e.preventDefault(); edge(true); return;
        case "End": e.preventDefault(); edge(false); return;
        case "Escape": e.preventDefault(); onClose(); return;
        case "Tab": onClose(); return; // no preventDefault: focus should move on
        default: break;
      }
      // Type-ahead. Single printable characters only, so a modifier chord is
      // left to whatever else is listening.
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
      const now = performance.now();
      const fresh = now - typedAt.current > 700;
      typed.current = fresh ? e.key : typed.current + e.key;
      typedAt.current = now;
      // REPEATING ONE LETTER CYCLES, it does not spell. "d" then "d" means
      // "the next item starting with d", not a search for "dd" - which matches
      // nothing, so the menu would appear to stop responding to the second
      // press. This is the APG behaviour and it is the case people actually
      // hit, since repeating a letter is how you get to the second Delete.
      const buf = typed.current.toLowerCase();
      const same = buf.length > 1 && [...buf].every((c) => c === buf[0]);
      jumpTo(same ? buf[0] : buf);
    }

    menu.addEventListener("keydown", onKey);
    return () => {
      menu.removeEventListener("keydown", onKey);
      typed.current = "";
    };
  }, [menuRef, open, onClose]);

  // Hand focus back on close, and ONLY if the menu still holds it. A menu item
  // that opens a dialog has deliberately moved focus somewhere else; yanking it
  // back to the trigger would undo that.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const back = returnTo.current;
      const active = document.activeElement;
      if (back && (active === document.body || active == null)) back.focus();
      returnTo.current = null;
    }
    wasOpen.current = open;
  }, [open]);
}
