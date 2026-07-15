import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconCamera, IconFilm, IconPlay, IconReveal, IconTranscript, IconVolume } from "./Icons";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import { formatBytes, formatModifiedDate } from "../lib/library";
import { shortenPath } from "../lib/filename";
import { findForSource, type TranscriptHistoryEntry } from "../lib/transcript-history";
import type { LibraryItem } from "../types";

type Props = {
  item: LibraryItem;
  requestThumb: (path: string) => Promise<string | null>;
  /** Open this file in the Clip view (the primary action). */
  onOpenInClip: () => void;
  /** Open the "Choose thumbnail…" picker (video only). */
  onChoosePoster: (path: string) => void;
  /** Open a matched transcript through the existing history handler. */
  onOpenTranscript: (entry: TranscriptHistoryEntry) => void;
  /** Clear the selection (× / Esc). */
  onClose: () => void;
};

/**
 * The Library browser's right detail panel — appears on selection. Large
 * poster, name, shortened path, size · date, and the file's actions. A
 * "Has transcript" chip shows when transcript-history has an entry for this
 * exact path; clicking it opens the source and that transcript. Remounted by
 * the parent (keyed on path + poster version) so a thumbnail change refreshes.
 */
export function LibraryDetail({
  item, requestThumb, onOpenInClip, onChoosePoster, onOpenTranscript, onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const isVideo = item.kind === "video";
  const [thumb = null] = useLazyThumbnails(ref, isVideo ? [item.path] : [], requestThumb);
  const showImg = !!thumb && !broken;
  const transcript = findForSource({ sourcePath: item.path });
  const meta = [formatBytes(item.size_bytes), formatModifiedDate(item.modified_ms)]
    .filter(Boolean).join(" · ");

  return (
    <aside ref={ref} className="cp-lib-detail" aria-label="File details">
      <div className="cp-lib-detail-head">
        <button
          type="button"
          className="cp-lib-detail-close"
          title="Close (Esc)"
          aria-label="Close details"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="cp-lib-detail-art">
        {showImg
          ? <img src={thumb} alt="" draggable={false} onError={() => setBroken(true)} />
          : (
            <span className="cp-lib-detail-ph">
              {item.kind === "audio" ? <IconVolume size={28} /> : <IconFilm size={28} />}
            </span>
          )}
      </div>
      <h2 className="cp-lib-detail-name" title={item.name}>{item.name}</h2>
      <p className="cp-lib-detail-path" title={item.path}>{shortenPath(item.path, 44)}</p>
      {meta && <p className="cp-lib-detail-meta">{meta}</p>}

      {transcript && (
        <button
          type="button"
          className="cp-lib-detail-chip"
          onClick={() => onOpenTranscript(transcript)}
          title="Open the source and its transcript"
        >
          <IconTranscript size={13} /> Has transcript
        </button>
      )}

      <div className="cp-lib-detail-actions">
        <button type="button" className="btn btn-primary" onClick={onOpenInClip}>
          <IconPlay size={13} /> Open in Clip
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => { invoke("reveal_in_finder", { path: item.path }).catch(() => { /* ignore */ }); }}
        >
          <IconReveal size={13} /> Reveal in Finder
        </button>
        {isVideo && (
          <button type="button" className="btn" onClick={() => onChoosePoster(item.path)}>
            <IconCamera size={13} /> Choose thumbnail…
          </button>
        )}
      </div>
    </aside>
  );
}
