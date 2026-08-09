import { TAG_COLORS, type TagColorIndex } from "../lib/finder-tags";
import type { FinderTag } from "../bindings/FinderTag";
import { IconCircleX } from "./Icons";

/**
 * Finder's colour row, at the top of a file's context menu.
 *
 * WHERE FINDER PUTS IT, because that is where the muscle memory is: a row of
 * dots above the verbs, not a submenu. Setting a colour is one click from
 * right-click, which is the whole reason people use tags at all.
 *
 * THESE ARE REAL FINDER TAGS. A colour set here is written to the file's own
 * extended attribute, so it shows on the icon in Finder too, and a folder
 * already tagged in Finder arrives here wearing its colour. That is also why
 * the row is exactly seven: the format has seven slots and no eighth.
 *
 * A COLOUR ALREADY SET TOGGLES OFF. The ring marks what is on, and pressing a
 * lit dot clears it, so the row is reversible without hunting for an "undo
 * colour" item.
 */
export function TagColorRow({
  tags, onToggle, onClear,
}: {
  tags: readonly FinderTag[];
  onToggle: (index: TagColorIndex) => void;
  /** Strip every colour. Named tags survive; see clearTagColors. */
  onClear: () => void;
}) {
  const active = new Set(tags.map((t) => t.color));
  const anyColor = TAG_COLORS.some((c) => active.has(c.index));

  return (
    <div className="cp-tagrow" role="group" aria-label="Tag colour">
      {TAG_COLORS.map((c) => (
        <button
          key={c.index}
          type="button"
          className={"cp-tagrow-dot" + (active.has(c.index) ? " on" : "")}
          style={{ background: c.hex }}
          title={active.has(c.index) ? `Remove ${c.label}` : c.label}
          aria-label={c.label}
          aria-pressed={active.has(c.index)}
          onClick={(e) => { e.stopPropagation(); onToggle(c.index); }}
        />
      ))}
      <button
        type="button"
        className="cp-tagrow-clear"
        title={anyColor ? "Remove all colours" : "No colours to remove"}
        aria-label="No colour"
        disabled={!anyColor}
        onClick={(e) => { e.stopPropagation(); onClear(); }}
      >
        <IconCircleX size={13} />
      </button>
    </div>
  );
}
