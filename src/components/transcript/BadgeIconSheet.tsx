import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BADGE_GROUPS, searchBadgeIcons, type BadgeIconDef } from "./badge-icons";

/**
 * The full badge-icon vocabulary, behind the plus in the icon row.
 *
 * WHY A SHEET AND NOT A LONGER ROW. Fifty icons in a 288px popover is either
 * six wrapped rows that push the Rename button off the bottom of the screen, or
 * a horizontal scroller nobody discovers. A sheet gets its own space, its own
 * search, and its own grouping, and the row in front of it stays four kinds
 * plus four recents — small enough to read without stopping.
 *
 * THE HOVER STRIP IS THE POINT. A grid of unlabelled 24px glyphs is a guessing
 * game, and `title` does not answer it: the native tooltip waits about a second,
 * appears under the cursor rather than in a fixed place, and never fires for
 * keyboard focus at all. The strip along the bottom names whatever the pointer
 * or the focus ring is on, instantly and always in the same spot, so sweeping
 * the grid reads the whole set out. `title` and `aria-label` stay on each
 * button for the screen reader and for anyone who hovers and waits anyway.
 *
 * IT LIVES INSIDE THE POPOVER'S SUBTREE, not in its own portal, even though it
 * is positioned as if it floated free. The rename popover closes on any
 * mousedown outside its own element, so a portaled sheet would be "outside" and
 * every click on an icon would tear down the popover underneath it. Being a
 * real child makes `contains()` true and the problem disappear rather than
 * being papered over with a second exception in the popover's handler.
 */
export function BadgeIconSheet({
  anchorRect, value, onPick, onClose, ignoreRef,
}: {
  /** The button that opened this, so the sheet can sit under it. */
  anchorRect: DOMRect;
  /** Currently chosen id, or null / "none" for initials. */
  value: string | null;
  /** null means "back to initials". */
  onPick: (id: string | null) => void;
  onClose: () => void;
  /** The toggle button. A mousedown on it closes via its own onClick, so this
   *  handler must not also close and let the click reopen. */
  ignoreRef: React.RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [hint, setHint] = useState<BadgeIconDef | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchorRect.bottom + 6, left: anchorRect.left - 150 });

  const results = useMemo(() => searchBadgeIcons(query), [query]);
  const searching = query.trim().length > 0;

  // Measured, not estimated. The sheet's height depends on how many groups
  // survive the search, so a constant would be wrong for most queries and the
  // sheet would hang off the bottom of the screen exactly when the list is
  // long. Layout effect, so the correction lands before paint.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      top: Math.max(8, Math.min(window.innerHeight - height - 8, anchorRect.bottom + 6)),
      left: Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left - width / 2)),
    });
  }, [anchorRect, results.length]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || ignoreRef.current?.contains(t)) return;
      onClose();
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [onClose, ignoreRef]);

  return (
    <div
      ref={boxRef}
      className="cp-badgesheet"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label="Choose a speaker icon"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        className="cp-badgesheet-search"
        placeholder="Search icons"
        value={query}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          // Enter takes the best match, so a search can be finished without
          // moving to the mouse.
          if (e.key === "Enter" && results.length > 0) {
            e.preventDefault();
            onPick(results[0].id);
          }
        }}
      />

      <div className="cp-badgesheet-body">
        {/* The way back, first, and present whether or not a search is running:
            it is the one choice that is not in the catalogue, so leaving it out
            of results would make it unreachable from here. */}
        <button
          type="button"
          className={"cp-badgesheet-cell wide" + (!value || value === "none" ? " picked" : "")}
          title="Initials"
          aria-label="Initials"
          onClick={() => onPick(null)}
          onMouseEnter={() => setHint(null)}
          onFocus={() => setHint(null)}
        >
          <span className="cp-badgesheet-initials">Aa</span>
          <span className="cp-badgesheet-cell-label">Initials</span>
        </button>

        {searching ? (
          results.length === 0 ? (
            <div className="cp-badgesheet-empty">No icon matches that</div>
          ) : (
            <div className="cp-badgesheet-grid">
              {results.map((b) => (
                <Cell key={b.id} def={b} picked={value === b.id} onPick={onPick} onHint={setHint} />
              ))}
            </div>
          )
        ) : (
          BADGE_GROUPS.map((g) => {
            const inGroup = results.filter((b) => b.group === g);
            return (
              <div key={g} className="cp-badgesheet-group">
                <div className="cp-badgesheet-grouplabel">{g}</div>
                <div className="cp-badgesheet-grid">
                  {inGroup.map((b) => (
                    <Cell key={b.id} def={b} picked={value === b.id} onPick={onPick} onHint={setHint} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Named in one fixed place, instantly, for pointer and keyboard alike. */}
      <div className="cp-badgesheet-hint" aria-live="polite">
        {hint ? hint.label : "Hover an icon to see what it is"}
      </div>
    </div>
  );
}

function Cell({
  def, picked, onPick, onHint,
}: {
  def: BadgeIconDef;
  picked: boolean;
  onPick: (id: string) => void;
  onHint: (d: BadgeIconDef | null) => void;
}) {
  const Glyph = def.Glyph;
  return (
    <button
      type="button"
      className={"cp-badgesheet-cell" + (picked ? " picked" : "")}
      title={def.label}
      aria-label={def.label}
      aria-pressed={picked}
      onClick={() => onPick(def.id)}
      onMouseEnter={() => onHint(def)}
      onMouseLeave={() => onHint(null)}
      onFocus={() => onHint(def)}
      onBlur={() => onHint(null)}
    >
      <Glyph size={16} strokeWidth={1.9} />
    </button>
  );
}
