/** SIZE NOTE (150-line rule): over budget since the hover-frame crossfade
 *  and poster-fallback layers landed. The layers share refs and timing
 *  state so a sibling split would thread 6+ props for zero reuse; keeping
 *  one file was the deliberate call. Revisit if another media layer lands. */
import { useRef, useState } from "react";
import { rememberAspect } from "../lib/art-aspect";
import { reviewStatusForKey } from "../lib/review-store";
import { ReviewStatusChip } from "./ReviewStatusChip";
import { IconFilm, IconMore, IconPlay, IconVolume } from "./Icons";
import { LibraryCardMenu } from "./LibraryCardMenu";
import { chosenPosterFor } from "../lib/library";
import { useHoverFrames } from "../hooks/use-hover-frames";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import { requestHeroStill } from "../hooks/use-library-scan";

/** Where a card's poster art comes from. */
export type LibraryCardArt =
  /** Scanned/recent local file — video posters load lazily on intersection;
   *  audio always keeps the glyph placeholder (nothing to frame-grab). */
  | { kind: "local"; path: string; media: "video" | "audio" }
  /** Web source — a derivable poster URL (YouTube) or null → placeholder.
   *  `urls` (optional, wins over `url`) is a resolution candidate list tried
   *  in order (e.g. maxres → hqdefault); onError advances to the next. */
  | { kind: "remote"; url: string | null; urls?: string[] };

type Props = {
  title: string;
  /** Second line — size · date for files, host · recency for web sources.
   *  Revealed on hover/focus along with the play glyph. */
  detail: string;
  art: LibraryCardArt;
  /** Small corner tag, e.g. "web" on Continue-row URLs, "srt" on transcripts. */
  badge?: string;
  /** Featured size — the Continue row's large landscape cards (~2x width). */
  large?: boolean;
  onOpen: () => void;
  /** Optional: open this source straight into the Review workspace. */
  onReview?: () => void;
  /** The shared, cached, concurrency-capped thumbnail loader. */
  requestThumb: (path: string) => Promise<string | null>;
  /** Opens the "Choose thumbnail…" picker for this path. Only wired for
   *  local-VIDEO cards (audio/remote have no frame to pick). */
  onChoosePoster?: (path: string) => void;
  /** Clears this path's chosen thumbnail, reverting to the auto frame. */
  onResetPoster?: (path: string) => void;
  /**
   * Library-browser selection mode. When present, a single click / Space
   * SELECTS (shows the detail panel) and double-click / Enter OPENS in Clip.
   * Absent (Home shelves) → the card opens on a single click, as before.
   */
  onSelect?: () => void;
  /** Highlights the card as the current browser selection. */
  selected?: boolean;
};

/**
 * 16:9 poster card — the Library's unit tile. A <button> inside a
 * role="listitem" cell (rows are role="list"); LibraryRow's roving
 * tabindex targets the .cp-lib-card class, so keep it on the button.
 * Hover/focus scales the art and reveals the play glyph + detail line
 * (CSS, reduced-motion aware). A broken poster (evicted blob URL, dead
 * remote) falls back to the tokens-styled placeholder via onError.
 * Local-video cards also run the hover frame cycle (use-hover-frames):
 * dwell 600ms and the poster cross-dissolves through frames at 25/50/75%
 * of duration; leaving snaps back. Skipped for remote/audio and under
 * prefers-reduced-motion.
 *
 * Right-click, the ⋯ corner button, and the ContextMenu / Shift+F10 keys all
 * open the SAME LibraryCardMenu (never the picker directly); local-video cards
 * get the thumbnail items, everything local gets Reveal in Finder, all get
 * Open in Clip. The menu never triggers the card's open.
 */
export function LibraryCard({
  title, detail, art, badge, large, onOpen, onReview, requestThumb, onChoosePoster, onResetPoster,
  onSelect, selected,
}: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  /** The ⋯ trigger. Separate from btnRef, which is the whole CARD: anchoring
   *  the menu to the card put it at the card's bottom-left corner, nowhere
   *  near the button that opened it. */
  const moreRef = useRef<HTMLButtonElement>(null);
  const [broken, setBroken] = useState(false);
  // Remote candidate cursor — onError advances through art.urls; past the end
  // the placeholder takes over (url resolves undefined → showImg false).
  const [remoteIdx, setRemoteIdx] = useState(0);
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number; align?: "left" | "right" } | null>(null);
  const isVideo = art.kind === "local" && art.media === "video";
  const lazyPaths = isVideo ? [art.path] : [];
  // Featured (`large`) cards display ~432px wide (864 on Retina) — the 480px
  // card poster upscales soft, so they ask for the hero-resolution still
  // instead (same cache/decode gate/generation guard; it falls back to the
  // poster pipeline internally when WebCodecs can't decode).
  const [lazyUrl = null] = useLazyThumbnails(
    btnRef, lazyPaths, large ? requestHeroStill : requestThumb,
  );
  // Hover frame cycling — local video only (null disables the hook entirely
  // for remote/audio cards). Decodes ONLY after 600ms of hover/focus intent.
  // Frames stay 480px even on large cards: they're a transient dissolve, not
  // resting art — acceptable softness beats doubling the decode cost.
  const { frames, active, start: startCycle, stop: stopCycle } =
    useHoverFrames(isVideo ? art.path : null);

  const remoteUrls = art.kind === "remote"
    ? (art.urls ?? (art.url != null ? [art.url] : []))
    : null;
  const url = remoteUrls ? (remoteUrls[remoteIdx] ?? null) : lazyUrl;
  const showImg = !!url && !broken;
  const isAudio = art.kind === "local" && art.media === "audio";
  // Local-video path (narrows art to the local case) → the thumbnail items.
  const posterPath = art.kind === "local" && art.media === "video" ? art.path : null;
  const canPick = !!posterPath && !!onChoosePoster;
  // Any local source has a path to reveal; web sources don't.
  const revealPath = art.kind === "local" ? art.path : null;
  // Corner verdict chip - only when this source has an explicit approval
  // status (review-store's hydrated map; best-effort for fingerprint keys).
  const reviewVerdict = reviewStatusForKey(art.kind === "local" ? art.path : art.url ?? "");
  // 12a: portrait posters render contained over a blurred fill instead of
  // being cropped/squeezed to 16:9. Measured for free at the img's onLoad.
  const [portrait, setPortrait] = useState(false);

  const closeMenu = () => { setMenuAnchor(null); btnRef.current?.focus(); };
  /** Keyboard path (ContextMenu / Shift+F10): focus is on the CARD, so the
   *  card is the right thing to point at. */
  const openMenuAtCard = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenuAnchor({ x: r.left + 12, y: r.bottom - 24 });
  };
  /** The ⋯ button: drop from just under it, right-aligned, so the menu appears
   *  where the user actually clicked. */
  const openMenuAtMore = () => {
    const r = moreRef.current?.getBoundingClientRect();
    if (r) setMenuAnchor({ x: r.right, y: r.bottom + 4, align: "right" });
  };

  return (
    <div
      role="listitem"
      className={"cp-lib-cell" + (large ? " lg" : "")}
      // Cycling tracks the whole cell (so dwelling on the ⋯ corner counts as
      // hover) plus the button's keyboard focus below — as SEPARATE intents,
      // so a blur can't kill a pointer-held cycle (or vice versa).
      onMouseEnter={isVideo ? () => startCycle("hover") : undefined}
      onMouseLeave={isVideo ? () => stopCycle("hover") : undefined}
    >
      {reviewVerdict && (
        <span className="cp-lib-cell-status">
          <ReviewStatusChip state={reviewVerdict.state} compact />
        </span>
      )}
      <button
        ref={btnRef}
        type="button"
        className={"cp-lib-card" + (selected ? " selected" : "")}
        onFocus={isVideo ? () => startCycle("focus") : undefined}
        onBlur={isVideo ? () => stopCycle("focus") : undefined}
        // Selection mode: single click selects, double-click opens. Home shelves
        // (no onSelect) keep the single-click-opens behavior.
        onClick={onSelect ?? onOpen}
        onDoubleClick={onSelect ? onOpen : undefined}
        aria-current={onSelect ? (selected ? "true" : undefined) : undefined}
        title={title}
        onContextMenu={(e) => { e.preventDefault(); setMenuAnchor({ x: e.clientX, y: e.clientY }); }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); openMenuAtCard(); return; }
          // In selection mode Enter opens (preventDefault stops the synthesized
          // click that would otherwise just re-select). Space still selects.
          if (onSelect && e.key === "Enter") { e.preventDefault(); onOpen(); }
        }}
      >
        <span className={"cp-lib-card-art" + (portrait ? " portrait" : "")}>
          {showImg ? (
            <>
              {portrait && <img className="cp-art-blur" src={url} alt="" aria-hidden draggable={false} />}
              <img
                src={url}
                alt=""
                draggable={false}
                // Remote art walks its candidate list before the placeholder;
                // local art (one URL) breaks straight to it.
                onError={() => {
                  if (remoteUrls) setRemoteIdx((i) => i + 1);
                  else setBroken(true);
                }}
                // YouTube serves its "no thumbnail" placeholder with HTTP 200
                // (always 120x90; real thumbs are >= 320 wide), so onError never
                // fires for it. Detect it on LOAD and advance the walk.
                onLoad={(e) => {
                  if (remoteUrls && e.currentTarget.naturalWidth <= 120) { setRemoteIdx((i) => i + 1); return; }
                  const a = rememberAspect(url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
                  setPortrait(a === "portrait");
                }}
              />
              {/* Hover cycle overlays — stacked over the poster, one "on" at a
                  time (CSS cross-dissolve). Unmounting them (stopCycle) IS the
                  instant snap back to the poster. */}
              {frames.map((f, i) => (
                <img
                  key={f}
                  className={"cp-lib-card-frame" + (i === active ? " on" : "")}
                  src={f}
                  alt=""
                  draggable={false}
                />
              ))}
            </>
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
        ref={moreRef}
        type="button"
        className="cp-lib-more"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        /* Out of the tab order on purpose. It is a hover affordance that
           duplicates the card's own menu, and leaving it focusable made every
           card TWO tab stops — 800 of them on a 400-file drive. Keyboard users
           reach the identical menu from the card itself via the ContextMenu
           key or Shift+F10, so nothing is lost. */
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); if (menuAnchor) closeMenu(); else openMenuAtMore(); }}
      >
        <IconMore size={15} />
      </button>
      {menuAnchor && (
        <LibraryCardMenu
          anchor={menuAnchor}
          align={menuAnchor.align}
          canPickThumbnail={canPick}
          hasChosenThumbnail={!!posterPath && chosenPosterFor(posterPath) != null}
          revealPath={revealPath}
          onChooseThumbnail={() => { if (posterPath) onChoosePoster?.(posterPath); }}
          onResetThumbnail={() => { if (posterPath) onResetPoster?.(posterPath); }}
          onOpen={onOpen}
          onReview={onReview}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
