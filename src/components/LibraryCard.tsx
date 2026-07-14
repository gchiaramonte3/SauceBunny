import { useRef, useState } from "react";
import { IconFilm, IconPlay, IconVolume } from "./Icons";
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
};

/**
 * 16:9 poster card — the Library's unit tile. A <button> inside a
 * role="listitem" cell (rows are role="list"); LibraryRow's roving
 * tabindex targets the .cp-lib-card class, so keep it on the button.
 * Hover/focus scales the art and reveals the play glyph + detail line
 * (CSS, reduced-motion aware). A broken poster (evicted blob URL, dead
 * remote) falls back to the tokens-styled placeholder via onError.
 */
export function LibraryCard({ title, detail, art, badge, onOpen, requestThumb }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [broken, setBroken] = useState(false);
  const lazyPaths = art.kind === "local" && art.media === "video" ? [art.path] : [];
  const [lazyUrl = null] = useLazyThumbnails(btnRef, lazyPaths, requestThumb);

  const url = art.kind === "remote" ? art.url : lazyUrl;
  const showImg = !!url && !broken;
  const isAudio = art.kind === "local" && art.media === "audio";

  return (
    <div role="listitem" className="cp-lib-cell">
      <button ref={btnRef} type="button" className="cp-lib-card" onClick={onOpen} title={title}>
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
    </div>
  );
}
