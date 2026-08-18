import { useEffect, useMemo, useRef, useState } from "react";

/** One reassignment target, already display-named and ordered by talk time. */
export type FlyoutSpeaker = { tag: string; name: string; color: string };

/**
 * The "Assign to speaker" submenu, for casts too big to list flat.
 *
 * A right-click menu on a 26-person documentary put one "Assign to …" row per
 * speaker inline, so the menu grew past the height of the window and the three
 * verbs that are not reassignment — split, play, clear — were pushed off the
 * end of a list nobody wants to read. Under about half a dozen people a flat
 * list is strictly better (one click, no hover, everything visible), so this
 * only takes over past the threshold in CueSelectionMenu.
 *
 * NO DOCUMENT LISTENERS, deliberately. It renders inside the parent popover's
 * element, so the outside-click and Escape handling CueSelectionMenu already
 * owns covers it for free. A second hand-rolled dismisser is the exact thing
 * `dismiss-parity-contract` refuses, and it would also be the thing that made
 * Escape close the whole menu when it should close one panel.
 *
 * The filter is the reason this beats a scroll. Once a list is long enough to
 * need a submenu it is long enough that reading it is the slow part, and a
 * cast is a set of names people know. It filters rather than promotes (which
 * is what NewSpeakerSheet does) because THAT field's first job is naming
 * somebody new, so emptying its list would read as an error; here the field
 * has one job, finding, and a list narrowed to one row is the win.
 */
export function SpeakerAssignFlyout({ speakers, onPick, onBack, side, top }: {
  speakers: FlyoutSpeaker[];
  onPick: (tag: string) => void;
  /** Escape / ArrowLeft: hand focus back to the parent menu item. */
  onBack: () => void;
  /** Which way it opens, so it never runs off the edge of the screen. */
  side: "left" | "right";
  /** Vertical offset within the parent menu, in px. */
  top: number;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return speakers;
    return speakers.filter((s) => s.name.toLowerCase().includes(q));
  }, [speakers, query]);

  /** Roving focus across the rows; the field is the row above the first. */
  const move = (from: number, dir: 1 | -1) => {
    const next = from + dir;
    if (next < 0) { inputRef.current?.focus(); return; }
    if (next >= shown.length) return;
    btnRefs.current[next]?.focus();
  };

  return (
    <div
      className={`cp-cuemenu-flyout ${side === "left" ? "to-left" : "to-right"}`}
      style={{ top }}
      role="menu"
      aria-label="Assign to speaker"
      // Stops the parent's roving arrow-key handler from also acting on keys
      // meant for this panel, which would move focus in two menus at once.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="cp-cuemenu-filter"
        value={query}
        placeholder="Find a speaker…"
        spellCheck={false}
        aria-label="Filter speakers"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); btnRefs.current[0]?.focus(); }
          // Enter on a filter that has narrowed to exactly one person assigns
          // them: having typed enough to be unambiguous, a second gesture to
          // confirm what is already the only option is ceremony.
          else if (e.key === "Enter" && shown.length === 1) { e.preventDefault(); onPick(shown[0].tag); }
          else if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); onBack(); }
        }}
      />
      <div className="cp-cuemenu-flyout-list">
        {shown.map((s, i) => (
          <button
            key={s.tag}
            ref={(el) => { btnRefs.current[i] = el; }}
            type="button"
            role="menuitem"
            className="cp-lib-menu-item"
            onClick={() => onPick(s.tag)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); move(i, 1); }
              else if (e.key === "ArrowUp") { e.preventDefault(); move(i, -1); }
              else if (e.key === "Escape" || e.key === "ArrowLeft") { e.preventDefault(); onBack(); }
            }}
          >
            <span className="cp-lib-menu-icon" aria-hidden="true">
              <span className="cp-cuemenu-pip" style={{ background: s.color }} />
            </span>
            {s.name}
          </button>
        ))}
        {shown.length === 0 && (
          <div className="cp-cuemenu-flyout-empty">No speaker matches “{query.trim()}”</div>
        )}
      </div>
    </div>
  );
}
