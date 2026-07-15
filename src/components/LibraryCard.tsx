import { useRef, useState } from "react";
import { IconFilm, IconMore, IconPlay, IconVolume } from "./Icons";
import { LibraryCardMenu } from "./LibraryCardMenu";
import { chosenPosterFor } from "../lib/library";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";

/** Where a card's poster art comes from. */
export type LibraryCardArt =
  /** Scanned/recent local file — video posters load lazily on intersection;
   *  audio always keeps the glyph placeholder (nothing to frame-grab). */
  | { kind: "local"; path: string; media: "video" | "audio" }
  /** Web source — a derivable poster URL (YouTube) or null → placeholder. */
  | { kind: "remote"; url: string | null };

type Props = {
  title: string;
  /** Second line — size · date for files, host · recency for web sources.
   *  Revealed on hover/focus along with the play glyph. */
  detail: string;
  art: LibraryCardArt;
  /** Small corner tag, e.g. "web" on Continue-row URLs, "srt" on transcripts. */
  badge?: string;
  onOpen: () => void;
  /** LibraryView's cached, concurrency-capped thumbnail loader. */
  requestThumb: (path: string) => Promise<string | null>;
  /** Opens the "Choose thumbnail…" picker for this path. Only wired for
   *  local-VIDEO cards (audio/remote have no frame to pick). */
  onChoosePoster?: (path: string) => void;
  /** Clears this path's chosen thumbnail, reverting to the auto frame. */
  onResetPoster?: (path: string) => void;
};

/**
 * 16:9 poster card — the Library's unit tile. A <button> inside a
 * role="listitem" cell (rows are role="list"); LibraryRow's roving
 * tabindex targets the .cp-lib-card class, so keep it on the button.
 * Hover/focus scales the art and reveals the play glyph + detail line
 * (CSS, reduced-motion aware). A broken poster (evicted blob URL, dead
 * remote) falls back to the tokens-styled placeholder via onError.
 *
 * Right-click, the ⋯ corner button, and the ContextMenu / Shift+F10 keys all
 * open the SAME LibraryCardMenu (never the picker directly); local-video cards
 * get the thumbnail items, everything local gets Reveal in Finder, all get
 * Open in Clip. The menu never triggers the card's open.
 */
export function LibraryCard({
  title, detail, art, badge, onOpen, requestThumb, onChoosePoster, onResetPoster,
}: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [broken, setBroken] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const isVideo = art.kind === "local" && art.media === "video";
  const lazyPaths = isVideo ? [art.path] : [];
  const [lazyUrl = null] = useLazyThumbnails(btnRef, lazyPaths, requestThumb);

  const url = art.kind === "remote" ? art.url : lazyUrl;
  const showImg = !!url && !broken;
  const isAudio = art.kind === "local" && art.media === "audio";
  // Local-video path (narrows art to the local case) → the thumbnail items.
  const posterPath = art.kind === "local" && art.media === "video" ? art.path : null;
  const canPick = !!posterPath && !!onChoosePoster;
  // Any local source has a path to reveal; web sources don't.
  const revealPath = art.kind === "local" ? art.path : null;

  const closeMenu = () => { setMenuAnchor(null); btnRef.current?.focus(); };
  const openMenuAtRect = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenuAnchor({ x: r.left + 12, y: r.bottom - 24 });
  };

  return (
    <div role="listitem" className="cp-lib-cell">
      <button
        ref={btnRef}
        type="button"
        className="cp-lib-card"
        onClick={onOpen}
        title={title}
        onContextMenu={(e) => { e.preventDefault(); setMenuAnchor({ x: e.clientX, y: e.clientY }); }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); openMenuAtRect(); }
        }}
      >
        <span className="cp-lib-card-art">
          {showImg ? (
            <img src={url} alt="" draggable={false} onError={() => setBroken(true)} />
          ) : (
            <span className="cp-lib-card-ph">
              {isAudio ? <IconVolume size={22} /> : <IconFilm size={22} />}
              <span className="cp-lib-card-ph-name">{title}</span>
            </span>
          )}
          {badge && <span className="cp-lib-card-badge">{badge}</span>}
          <span className="cp-lib-card-play" aria-hidden="true">
            <IconPlay size={15} />
          </span>
        </span>
        <span className="cp-lib-card-title">{title}</span>
        <span className="cp-lib-card-detail">{detail}</span>
      </button>
      {/* Sibling of the card <button> (buttons can't nest) — the ⋯ trigger over
          the art's top-right corner, revealed with the card. Opens the SAME
          menu as right-click, giving mouse + keyboard users one path. */}
      <button
        type="button"
        className="cp-lib-more"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        onClick={(e) => { e.stopPropagation(); openMenuAtRect(); }}
      >
        <IconMore size={15} />
      </button>
      {menuAnchor && (
        <LibraryCardMenu
          anchor={menuAnchor}
          canPickThumbnail={canPick}
          hasChosenThumbnail={!!posterPath && chosenPosterFor(posterPath) != null}
          revealPath={revealPath}
          onChooseThumbnail={() => { if (posterPath) onChoosePoster?.(posterPath); }}
          onResetThumbnail={() => { if (posterPath) onResetPoster?.(posterPath); }}
          onOpen={onOpen}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
