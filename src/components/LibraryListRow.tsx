import { useRef, useState } from "react";
import { primarySwatch, type TagColorIndex } from "../lib/finder-tags";
import type { FinderTag } from "../bindings/FinderTag";
import { IconFilm, IconVolume } from "./Icons";
import { LibraryCardMenu } from "./LibraryCardMenu";
import { chosenPosterFor, formatBytes, formatModifiedDate } from "../lib/library";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import type { LibraryItem } from "../types";

type Props = {
  item: LibraryItem;
  selected: boolean;
  /** Single click / Space → show the detail panel. */
  /** Receives the event so ⌘/⇧ reach the selection rule. */
  onSelect: (e: React.MouseEvent) => void;
  /** Fired on right-click before the menu opens, so the parent can apply
   *  Finder's select-then-menu rule. */
  onContextSelect?: () => void;
  /** Rename this file (or the selection it is part of). */
  onRename?: () => void;
  /** Finder tags: the colour dot in the row, and the menu's colour row. */
  tags?: readonly FinderTag[];
  onToggleTagColor?: (index: TagColorIndex) => void;
  onClearTagColors?: () => void;
  /** Double click / Enter → open in Clip. */
  onOpen: () => void;
  /** "Review this clip": open the source and land in Review. */
  onReview?: () => void;
  requestThumb: (path: string) => Promise<string | null>;
  onChoosePoster: (path: string) => void;
  onResetPoster: (path: string) => void;
};

/**
 * One row of the Library browser's list mode — a plain button (announced as a
 * button, with aria-current for the selected state, matching LibraryCard rather
 * than a static role="table"/row) carrying a tiny lazy poster, name, kind,
 * size, and modified date. Single click selects, double-click (or Enter) opens,
 * ContextMenu/Shift+F10 open the same LibraryCardMenu.
 */
export function LibraryListRow({
  item, selected, onSelect, onContextSelect, onRename, onOpen, onReview, requestThumb, onChoosePoster, onResetPoster,
  tags, onToggleTagColor, onClearTagColors,
}: Props) {
  const swatch = primarySwatch(tags ?? []);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [broken, setBroken] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const isVideo = item.kind === "video";
  const [thumb = null] = useLazyThumbnails(btnRef, isVideo ? [item.path] : [], requestThumb);
  const showImg = !!thumb && !broken;

  const closeMenu = () => { setMenuAnchor(null); btnRef.current?.focus(); };
  const openMenuAtRect = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenuAnchor({ x: r.left + 24, y: r.bottom - 8 });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-current={selected ? "true" : undefined}
        className={"cp-lib-lrow" + (selected ? " selected" : "")}
        data-path={item.path}
        title={item.name}
        onClick={(e) => onSelect(e)}
        onDoubleClick={onOpen}
        onContextMenu={(e) => {
          e.preventDefault();
          // Select FIRST, so the menu acts on what is under the cursor. Finder's
          // rule: an unselected item becomes the selection; one already in the
          // selection leaves it intact so the menu can act on the whole set.
          onContextSelect?.();
          setMenuAnchor({ x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); openMenuAtRect(); return; }
          if (e.key === "Enter") { e.preventDefault(); onOpen(); }
        }}
      >
        <span className="cp-lib-lrow-art">
          {showImg
            ? <img src={thumb} alt="" draggable={false} onError={() => setBroken(true)} />
            : (item.kind === "audio" ? <IconVolume size={13} /> : <IconFilm size={13} />)}
        </span>
        {/* The tag dot lives INSIDE the name cell, like Finder's, and not as
            its own grid column: the row is a five-track grid shared with the
            header, and a sixth child shifted every cell one track over — names
            vanished into the 64px Kind track and dates wrapped onto their own
            line. A dot needs no track; it needs to sit beside the name. */}
        <span
          className="cp-lib-lrow-name"
          // Finder's slow double-click: a second click on the NAME of a file
          // that is already selected opens rename. Guarded on `selected` and on
          // the name cell specifically, so it can never fire as the second half
          // of an ordinary double-click-to-open (that click lands while the row
          // was NOT yet selected, or lands outside this cell).
          onClick={(e) => {
            if (!selected || !onRename) return;
            if (e.shiftKey || e.metaKey || e.ctrlKey || e.detail > 1) return;
            e.stopPropagation();
            onRename();
          }}
        >
          {swatch && (
            <span
              className="cp-lib-lrow-dot"
              style={{ background: swatch.hex }}
              aria-hidden="true"
            />
          )}
          {item.name}
        </span>
        {/* `capitalize` lives on THIS cell rather than the shared class: the
            Library's kind is a lowercase enum, while the same column holds a
            filename in Frames and a hostname in the web shelf - where
            capitalising turned "turbores-sample.mov" into
            "Turbores-Sample.Mov", because a hyphen and a dot are both word
            boundaries. */}
        <span className="cp-lib-lrow-kind cp-lib-lrow-kindword">{item.kind}</span>
        <span className="cp-lib-lrow-size">{formatBytes(item.size_bytes)}</span>
        <span className="cp-lib-lrow-date">{formatModifiedDate(item.modified_ms)}</span>
      </button>
      {menuAnchor && (
        <LibraryCardMenu
          onRename={onRename}
          tags={tags}
          onToggleTagColor={onToggleTagColor}
          onClearTagColors={onClearTagColors}
          anchor={menuAnchor}
          canPickThumbnail={isVideo}
          hasChosenThumbnail={isVideo && chosenPosterFor(item.path) != null}
          revealPath={item.path}
          onChooseThumbnail={() => onChoosePoster(item.path)}
          onResetThumbnail={() => onResetPoster(item.path)}
          onOpen={onOpen}
          onReview={onReview}
          onClose={closeMenu}
        />
      )}
    </>
  );
}
