import { useRef, useState } from "react";
import { IconFolder } from "./Icons";
import { useLazyThumbnails } from "../hooks/use-lazy-thumbnails";

type Props = {
  /** First video path under the root (BFS), or null → folder glyph. */
  path: string | null;
  /** The shared, cached, concurrency-capped thumbnail loader. */
  requestThumb: (path: string) => Promise<string | null>;
};

/**
 * Small folder art for a Library panel root row — the root's first video
 * poster in a 26px tile (Spotify's library-row grammar). Rides the shared
 * lazy-thumbnail gate on its own element, so tree rows never decode eagerly:
 * the poster is requested only once the row scrolls into view, from the same
 * cache the cards fill. Decorative (aria-hidden) — the row's name is the
 * accessible label.
 */
export function LibraryTreeArt({ path, requestThumb }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [broken, setBroken] = useState(false);
  const [thumb = null] = useLazyThumbnails(ref, path ? [path] : [], requestThumb);
  const showImg = !!thumb && !broken;
  return (
    <span ref={ref} className="cp-lib-tree-art" aria-hidden="true">
      {showImg
        ? <img src={thumb} alt="" draggable={false} onError={() => setBroken(true)} />
        : <IconFolder size={12} />}
    </span>
  );
}
