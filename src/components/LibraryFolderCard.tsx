import { useRef, useState } from "react";
import { IconFolder } from "./Icons";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";
import { FolderTagMenu } from "./FolderTagMenu";
import { primarySwatch } from "../lib/finder-tags";
import type { FinderTag } from "../bindings/FinderTag";

type Props = {
  name: string;
  /** Recursive playable-item count — the "N items" line. */
  count: number;
  /** Up to 3 video paths inside the folder (libraryPosterPaths) — the stack. */
  posterPaths: string[];
  /** Drill in: LibraryView pushes this folder onto the breadcrumb chain. */
  onOpen: () => void;
  requestThumb: (path: string) => Promise<string | null>;
  /** Makes this tile a drop container for dragged cards. The value is what
   *  the drop handler receives - for frames, the folder's relative path. */
  dropKey?: string;
  /** A drag is currently over this tile. */
  dropActive?: boolean;
  /** The folder's absolute path. Right-click needs it, and so does the tint:
   *  both were absent, so a folder in the browse area was colourless and inert
   *  while the SAME folder in the sidebar tree wore its Finder tag and opened a
   *  menu. One library, two answers. */
  path?: string;
  /** Its Finder tags, for the folder-glyph tint. */
  tags?: readonly FinderTag[];
  /** Tags were written; the caller re-reads whatever shows the colour. */
  onTagsChanged?: () => void;
};

/**
 * Collection card for a subfolder — a fanned stack of up to three lazy
 * item posters (first video found sits on top), folder name, item count.
 * Shares .cp-lib-card with LibraryCard so row roving-tabindex and focus
 * treatment cover both card kinds; audio-only folders keep the folder
 * glyph placeholder.
 */
export function LibraryFolderCard({
  name, count, posterPaths, onOpen, requestThumb, dropKey, dropActive, path, tags, onTagsChanged,
}: Props) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /* The tint rides the folder GLYPH, not a separate dot. The glyph is already
     a filled folder shape, so colouring it IS the Finder treatment - the same
     reasoning the sidebar tree's rows use, and the reason there is no swatch
     competing for tile space. */
  const swatch = primarySwatch(tags ?? []);
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
        className={"cp-lib-card cp-lib-foldercard" + (dropActive ? " dropping" : "")}
        data-drop={dropKey}
        onClick={onOpen}
        onContextMenu={path ? (e) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); } : undefined}
        // The keyboard route to the same menu. Without it a folder's colours
        // are mouse-only (WCAG 2.1.1), which is how the file cards already
        // behave and is the reason this matches them.
        onKeyDown={path ? (e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setMenuAt({ x: r.left + 12, y: r.bottom - 4 });
          }
        } : undefined}
        title={`${name} · ${items}`}
      >
        <span className="cp-lib-card-art">
          {posterPaths.length === 0 ? (
            <span className="cp-lib-card-ph">
              <IconFolder size={24} style={swatch ? { color: swatch.hex } : undefined} />
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
        {/* A tagged folder that HAS posters shows a stack, not a glyph, so
            the tint from the no-poster branch above has nowhere to live. The
            badge is that colour's home: small, in the art's corner, and only
            present when there is a tag to show. Finder tints the folder icon;
            this is the nearest thing a poster stack has to one. */}
        {swatch && posterPaths.length > 0 && (
          <span className="cp-lib-foldercard-tag" style={{ color: swatch.hex }} aria-hidden>
            <IconFolder size={12} />
          </span>
        )}
        <span className="cp-lib-card-title">{name}</span>
        <span className="cp-lib-card-detail">{items}</span>
      </button>
      {menuAt && path && (
        <FolderTagMenu
          path={path}
          anchor={menuAt}
          onClose={() => setMenuAt(null)}
          onChanged={() => onTagsChanged?.()}
        />
      )}
    </div>
  );
}
