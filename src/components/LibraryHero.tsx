import { useRef, useState } from "react";
import { IconPlay } from "./Icons";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import { formatTimeAgo } from "../lib/transcript-history";
import { secondsToHms } from "../lib/timecode";
import { hostnameOf, youTubeThumbnailUrl } from "../lib/validation";
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
  requestThumb: (path: string) => Promise<string | null>;
};

/**
 * Full-width hero over the most recent source: its poster as a blurred,
 * darkened backdrop under a gradient that dissolves into the bg-0 page
 * (Netflix treatment), title + host/recency line, and Resume / Open in
 * Clip actions — both open the source through the same callback. With no
 * recents yet it flips to the empty invitation (Add a folder / Paste a
 * URL) on the app's brand-wash gradient.
 */
export function LibraryHero({ recent, onOpen, onAddFolder, onPasteUrl, requestThumb }: Props) {
  const ref = useRef<HTMLElement>(null);
  // Local-file backdrops ride the same lazy loader as the cards; web
  // sources derive a poster URL locally (YouTube) or go without.
  const filePaths = recent?.kind === "file" ? [recent.value] : [];
  const [fileThumb = null] = useLazyThumbnails(ref, filePaths, requestThumb);
  // Backdrop URL that failed to load — a dead remote thumb or an evicted blob
  // falls back to the shade over bg-0 instead of WKWebView's broken-image
  // chrome (mirrors LibraryCard's onError). Stored as the URL, not a boolean:
  // the Hero persists across source changes, so a new recent must clear it.
  const [brokenBg, setBrokenBg] = useState<string | null>(null);

  if (!recent) {
    return (
      <section className="cp-lib-hero empty" aria-label="Get started">
        <div className="cp-lib-hero-content">
          <h2 className="cp-lib-hero-title">Your library</h2>
          <p className="cp-lib-hero-sub">
            Add a folder of footage to browse it here, or paste a URL to pull
            something new into the Clip view.
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

  const backdrop = recent.kind === "url" ? youTubeThumbnailUrl(recent.value) : fileThumb;
  const sub = [
    recent.kind === "url" ? hostnameOf(recent.value) : "Local file",
    formatTimeAgo(recent.lastOpenedAt),
    recent.durationSeconds != null ? secondsToHms(recent.durationSeconds) : null,
  ].filter(Boolean).join(" · ");

  return (
    <section ref={ref} className="cp-lib-hero" aria-label="Continue watching">
      {backdrop && backdrop !== brokenBg && (
        <img
          className="cp-lib-hero-bg"
          src={backdrop}
          alt=""
          draggable={false}
          onError={() => setBrokenBg(backdrop)}
        />
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
