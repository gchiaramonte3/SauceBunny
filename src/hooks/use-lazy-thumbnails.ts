import { useEffect, useState, type RefObject } from "react";

/**
 * Lazy poster loading for the Library surfaces — LibraryCard,
 * LibraryFolderCard (up to 3 stack layers), and LibraryHero: the 3+
 * consumers that justify a shared hook (CLAUDE.md hooks rule).
 *
 * Watches `ref` with an IntersectionObserver; the FIRST time the element
 * enters the viewport it disconnects and fires `request(path)` for every
 * path, filling the returned slots (index-aligned with `paths`) as they
 * resolve. `null` slots mean pending-or-failed — the caller renders its
 * placeholder. `request` is LibraryView's module-scope loader, which
 * already de-dups, caches, and caps concurrency, so this hook stays a thin
 * visibility gate.
 *
 * Why intersection (not mount): the Library view is keep-alive-mounted at
 * app boot even while [hidden] under the Clip view, and display:none never
 * intersects — so booting into Clip costs zero thumbnail work, and cards
 * only decode once actually scrolled into sight.
 */
export function useLazyThumbnails(
  ref: RefObject<HTMLElement | null>,
  paths: readonly string[],
  request: (path: string) => Promise<string | null>,
): (string | null)[] {
  // Contents key — the `paths` array literal changes identity every render;
  // re-observing is only needed when the actual paths change.
  const key = paths.join("\n");
  const [urls, setUrls] = useState<(string | null)[]>(() => paths.map(() => null));

  useEffect(() => {
    // Reset slots when the paths change; bail (no re-render) when the
    // initializer already covers it (the common mount case).
    setUrls((prev) =>
      prev.length === paths.length && prev.every((u) => u === null)
        ? prev
        : paths.map(() => null),
    );
    const el = ref.current;
    if (paths.length === 0 || !el) return;
    let cancelled = false;
    const load = () => {
      paths.forEach((path, i) => {
        void request(path).then((url) => {
          if (cancelled || url == null) return;
          setUrls((prev) => {
            if (prev.length !== paths.length || prev[i] === url) return prev;
            const next = prev.slice();
            next[i] = url;
            return next;
          });
        });
      });
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        load();
      },
      // Small viewport prefetch margin. Horizontal shelf clipping still
      // applies hard edges (rootMargin can't extend into an ancestor
      // scroller), so off-shelf cards load exactly when scrolled in.
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
    // `key` stands in for the paths array contents; `request` is module-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, request]);

  return urls;
}
