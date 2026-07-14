import { useRef, useState } from "react";
import { IconFolder } from "./Icons";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";

type Props = {
  name: string;
  /** Recursive playable-item count — the "N items" line. */
  count: number;
  /** Up to 3 video paths inside the folder (libraryPosterPaths) — the stack. */
  posterPaths: string[];
  /** Drill in: LibraryView pushes this folder onto the breadcrumb chain. */
  onOpen: () => void;
  requestThumb: (path: string) => Promise<string | null>;
};

/**
 * Collection card for a subfolder — a fanned stack of up to three lazy
 * item posters (first video found sits on top), folder name, item count.
 * Shares .cp-lib-card with LibraryCard so row roving-tabindex and focus
 * treatment cover both card kinds; audio-only folders keep the folder
 * glyph placeholder.
 */
export function LibraryFolderCard({ name, count, posterPaths, onOpen, requestThumb }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const urls = useLazyThumbnails(btnRef, posterPaths, requestThumb);
  // Poster URLs that failed to load (dead remote / evicted blob) — hide that
  // stack layer instead of WKWebView's broken-image chrome (LibraryCard's
  // onError fallback; a Set because the stack shows up to 3 posters).
  const [brokenUrls, setBrokenUrls] = useState<Set<string>>(new Set());
  const items = `${count} item${count === 1 ? "" : "s"}`;

  return (
    <div role="listitem" className="cp-lib-cell">
      <button
        ref={btnRef}
        type="button"
        className="cp-lib-card cp-lib-foldercard"
        onClick={onOpen}
        title={`${name} — ${items}`}
      >
        <span className="cp-lib-card-art">
          {posterPaths.length === 0 ? (
            <span className="cp-lib-card-ph">
              <IconFolder size={24} />
            </span>
          ) : (
            // DOM order back→front; posterPaths[0] (shallowest video) renders
            // on top. urls stay index-aligned with posterPaths.
            posterPaths
              .map((path, i) => ({ path, i }))
              .reverse()
              .map(({ path, i }) => {
                const u = urls[i];
                return (
                  <span
                    key={path}
                    className={"cp-lib-stack " + (i === 0 ? "front" : i === 1 ? "mid" : "back")}
                  >
                    {u && !brokenUrls.has(u) && (
                      <img
                        src={u}
                        alt=""
                        draggable={false}
                        onError={() => setBrokenUrls((prev) => new Set(prev).add(u))}
                      />
                    )}
                  </span>
                );
              })
          )}
        </span>
        <span className="cp-lib-card-title">{name}</span>
        <span className="cp-lib-card-detail">{items}</span>
      </button>
    </div>
  );
}
