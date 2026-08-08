import { useRef, useState } from "react";
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
  item, selected, onSelect, onOpen, onReview, requestThumb, onChoosePoster, onResetPoster,
}: Props) {
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
        title={item.name}
        onClick={(e) => onSelect(e)}
        onDoubleClick={onOpen}
        onContextMenu={(e) => { e.preventDefault(); setMenuAnchor({ x: e.clientX, y: e.clientY }); }}
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
        <span className="cp-lib-lrow-name">{item.name}</span>
        <span className="cp-lib-lrow-kind">{item.kind}</span>
        <span className="cp-lib-lrow-size">{formatBytes(item.size_bytes)}</span>
        <span className="cp-lib-lrow-date">{formatModifiedDate(item.modified_ms)}</span>
      </button>
      {menuAnchor && (
        <LibraryCardMenu
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
