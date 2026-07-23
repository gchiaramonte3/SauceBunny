import { useRef, useState } from "react";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import { IconFilm, IconVolume } from "./Icons";
import type { LibraryCardArt } from "./LibraryCard";

/**
 * The leading thumbnail on one reader picker row. Same cache/lazy pipeline the
 * Library cards use, in a compact 16:9 tile:
 *  - local video → lazy poster via requestThumb (IntersectionObserver-gated in
 *    useLazyThumbnails, so a list of 80+ rows doesn't stampede the decoder);
 *  - local audio → a volume glyph (no frame to grab — the audio-skip that keeps
 *    doomed mediabunny/ffmpeg decodes off the queue);
 *  - web → the YouTube poster URL;
 *  - source-less transcript → a film glyph placeholder.
 * One component per row because hooks can't run inside the row .map().
 */
export function ReaderRowThumb({
  art, requestThumb, posterVersions,
}: {
  art: LibraryCardArt;
  requestThumb: (path: string) => Promise<string | null>;
  posterVersions: Record<string, number>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [broken, setBroken] = useState(false);

  const isLocalVideo = art.kind === "local" && art.media === "video";
  // Only video paths request a poster; audio/remote/source-less request nothing.
  const [lazyUrl = null] = useLazyThumbnails(ref, isLocalVideo ? [art.path] : [], requestThumb);
  const remoteUrl = art.kind === "remote" ? art.url : null;
  const url = remoteUrl ?? lazyUrl;

  // Re-key the local <img> on the poster version so a "Set thumbnail…" change
  // made in the Library refreshes this row too.
  const key = art.kind === "local" ? `${art.path}#${posterVersions[art.path] ?? 0}` : art.url ?? "none";
  const glyph = art.kind === "local" && art.media === "audio"
    ? <IconVolume size={14} />
    : <IconFilm size={14} />;

  return (
    <span ref={ref} className="cp-reader-row-thumb" aria-hidden="true">
      {url && !broken
        ? <img key={key} src={url} loading="lazy" alt="" draggable={false} onError={() => setBroken(true)} />
        : glyph}
    </span>
  );
}
