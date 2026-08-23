import { useRef, useState } from "react";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import { IconFilm, IconMore, IconVolume } from "./Icons";
import type { LibraryCardArt } from "./LibraryCard";

/**
 * The heading of one group in the Transcripts picker.
 *
 * Two shapes, because two different things are being labelled. A PROJECT is a
 * folder somebody named and filled, so it gets a picture, a count and the menu
 * that renames or empties it. A month bucket is the app's own filing, so it
 * gets a plain label and nothing to act on - offering "Delete" on 2026-08 would
 * be offering to bin a month of work that nobody chose to group.
 *
 * The picture reuses the row thumbnail pipeline exactly (lazy, shared cache),
 * so a project poster costs no decode the list was not already paying for.
 */
export function ReaderProjectHeader({
  label, count, art, isProject, accent, requestThumb, posterVersions, onMenu,
}: {
  label: string;
  count: number;
  /** Art for the transcript standing in as the project's picture, if any. */
  art: LibraryCardArt | null;
  /** False for a month bucket: no picture, no menu. */
  isProject: boolean;
  accent: string | null;
  requestThumb: (path: string) => Promise<string | null>;
  posterVersions: Record<string, number>;
  onMenu: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // Which poster failed, not "a poster failed". A bare boolean LATCHES: once
  // an image errored the component showed its glyph for the rest of its life,
  // so choosing a new picture for a project - the whole point of the menu -
  // left it pictureless until the panel remounted. Keying the failure to the
  // image that produced it resets on its own when the key changes, with no
  // effect to keep in sync.
  const [brokenKey, setBrokenKey] = useState<string | null>(null);
  const isLocalVideo = art?.kind === "local" && art.media === "video";
  const [lazyUrl = null] = useLazyThumbnails(
    ref, isLocalVideo && art ? [art.path] : [], requestThumb,
  );
  const url = art?.kind === "remote" ? art.url : lazyUrl;
  const key = art?.kind === "local" ? `${art.path}#${posterVersions[art.path] ?? 0}` : art?.url ?? "none";

  const broken = brokenKey === key;

  if (!isProject) {
    return (
      <h3 className="cp-reader-group-label">
        {label}
        <span className="cp-reader-group-count">{count}</span>
      </h3>
    );
  }

  const glyph = art?.kind === "local" && art.media === "audio"
    ? <IconVolume size={15} />
    : <IconFilm size={15} />;
  return (
    <h3
      className="cp-reader-project"
      style={accent ? { "--project-accent": accent } as React.CSSProperties : undefined}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
    >
      <span ref={ref} className="cp-reader-project-thumb" aria-hidden="true">
        {url && !broken
          ? <img key={key} src={url} loading="lazy" alt="" draggable={false} onError={() => setBrokenKey(key)} />
          : glyph}
      </span>
      <span className="cp-reader-project-body">
        <span className="cp-reader-project-title">{label}</span>
        <span className="cp-reader-project-count">
          {count} transcript{count === 1 ? "" : "s"}
        </span>
      </span>
      <button
        type="button"
        className="cp-reader-project-menu"
        aria-label={`Actions for ${label}`}
        title={`Actions for ${label}`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.right, r.bottom);
        }}
      >
        <IconMore size={14} />
      </button>
    </h3>
  );
}
