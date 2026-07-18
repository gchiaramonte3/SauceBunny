import { useRef, useState } from "react";
import { rememberAspect } from "../lib/art-aspect";
import { IconPlay } from "./Icons";
import { requestHeroStill } from "../hooks/use-library-scan";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import { formatTimeAgo } from "../lib/transcript-history";
import { secondsToHms } from "../lib/timecode";
import {
  hostnameOf,
  youTubeHeroThumbnailUrl,
  youTubeThumbnailUrl,
} from "../lib/validation";
import type { RecentSource } from "../lib/recent-sources";

type Props = {
  /** Most recent successfully-loaded source; null → the inviting empty hero. */
  recent: RecentSource | null;
  /** Routes through App's handleOpenRecentSource — the same handler the URL
   *  bar history popover uses. Switches to the Clip view upstream. */
  onOpen: (source: RecentSource) => void;
  onAddFolder: () => void;
  /** Switches to the Clip view and focuses the URL field. */
  onPasteUrl: () => void;
};

/**
 * Full-width hero over the most recent source — the Apple TV grammar: a
 * SHARP still anchored to the band's right edge (no blur), dissolving into
 * the bg-0 page through a two-axis gradient (opaque behind the text block on
 * the left, fading out at the bottom). Eyebrow + title + one metadata line +
 * Resume / Open in Clip, both routed through the same open callback.
 *
 * Local files decode a hero-resolution still through the shared thumbnail
 * infrastructure (requestHeroStill — same cache/gate/generation as the card
 * posters), lazily via the intersection hook so a hidden Home costs nothing.
 * Web sources walk a candidate list (YouTube maxres → hqdefault) with onError
 * chaining; when every candidate fails the shade over bg-0 carries the band.
 * With no recents yet it flips to the empty invitation on the brand wash.
 */
export function LibraryHero({ recent, onOpen, onAddFolder, onPasteUrl }: Props) {
  const ref = useRef<HTMLElement>(null);
  // Local-file art rides the same lazy intersection gate as the cards, but
  // asks for the hero-resolution still (sharp at band size, not the 480px
  // card poster upscaled).
  const filePaths = recent?.kind === "file" ? [recent.value] : [];
  const [fileStill = null] = useLazyThumbnails(ref, filePaths, requestHeroStill);
  // Backdrop URLs that failed to load (dead remote, evicted blob) — walk to
  // the next candidate instead of WKWebView's broken-image chrome. Stored as
  // URLs, not booleans: the hero persists across source changes, so a new
  // recent's candidates must not inherit another source's failures.
  // 12a: a portrait feature keeps the right-anchored composition but sits
  // contained over a blurred fill of itself.
  const [heroPortrait, setHeroPortrait] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  if (!recent) {
    return (
      <section className="cp-lib-hero empty" aria-label="Get started">
        <div className="cp-lib-hero-content">
          <h2 className="cp-lib-hero-title">Your library</h2>
          <p className="cp-lib-hero-sub">
            Add a folder of footage, or paste a URL.
          </p>
          <div className="cp-lib-hero-actions">
            <button type="button" className="btn btn-primary" onClick={onAddFolder}>
              Add a folder
            </button>
            <button type="button" className="btn" onClick={onPasteUrl}>
              Paste a URL
            </button>
          </div>
        </div>
      </section>
    );
  }

  const candidates = (
    recent.kind === "url"
      ? [youTubeHeroThumbnailUrl(recent.value), youTubeThumbnailUrl(recent.value)]
      : [fileStill]
  ).filter((u): u is string => u != null);
  const backdrop = candidates.find((u) => !failed.includes(u)) ?? null;
  const sub = [
    recent.kind === "url" ? hostnameOf(recent.value) : "Local file",
    formatTimeAgo(recent.lastOpenedAt),
    recent.durationSeconds != null ? secondsToHms(recent.durationSeconds) : null,
  ].filter(Boolean).join(" · ");

  return (
    <section ref={ref} className="cp-lib-hero" aria-label="Continue watching">
      {backdrop && (
        <>
          {heroPortrait && (
            <img className="cp-lib-hero-bg cp-art-blur" src={backdrop} alt="" aria-hidden draggable={false} />
          )}
          <img
          className={"cp-lib-hero-bg" + (heroPortrait ? " portrait" : "")}
          src={backdrop}
          alt=""
          draggable={false}
          onError={() => setFailed((f) => [...f, backdrop])}
          // YouTube's 120x90 "no thumbnail" placeholder arrives with HTTP 200;
          // treat a placeholder-sized load as a miss so the walk advances.
          onLoad={(e) => {
            if (e.currentTarget.naturalWidth <= 120) { setFailed((f) => [...f, backdrop]); return; }
            const a = rememberAspect(backdrop, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
            setHeroPortrait(a === "portrait");
          }}
          />
        </>
      )}
      <div className="cp-lib-hero-shade" />
      <div className="cp-lib-hero-content">
        <span className="cp-lib-hero-kicker">Continue watching</span>
        <h2 className="cp-lib-hero-title">{recent.title}</h2>
        <span className="cp-lib-hero-sub">{sub}</span>
        <div className="cp-lib-hero-actions">
          <button type="button" className="btn btn-primary" onClick={() => onOpen(recent)}>
            <IconPlay size={13} /> Resume
          </button>
          <button type="button" className="btn" onClick={() => onOpen(recent)}>
            Open in Clip
          </button>
        </div>
      </div>
    </section>
  );
}
