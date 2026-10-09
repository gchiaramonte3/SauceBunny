import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * A long transcript drawn a page at a time: only the pages near what is on
 * screen are real, and the rest are empty blocks of the height they had (or
 * an estimate, before they were ever drawn), so the scrollbar is honest and
 * nothing jumps.
 *
 * Drawing everything was measured on a real 20-mic, 3h39m sequence: 146,018
 * words became 1,017,132 DOM nodes and String Outs froze for 64 s in Chromium
 * (about 3.5 minutes in the app's WKWebView), most of it React finding where
 * to insert siblings. A page of a few hundred words renders in a frame.
 */

/** Words per page: a screen holds a page or two, and one renders in a frame. */
const PAGE_WORDS = 400;
/** For a page never drawn: roughly a line per 9 words, plus each paragraph's header. */
const PX_PER_WORD = 2.6, PX_PER_PARAGRAPH = 36;
/** How far past the visible edge pages are drawn, in pixels. Fixed rather than
 * a share of the view, so a pane that ever lost its height limit draws a few
 * screens, not the whole transcript. */
const DRAW_AHEAD_PX = 1200;
/** Pages drawn before any has been seen, so a short transcript is simply there. */
const FIRST_PAGES = 2;

type Props = {
  /** The scrolling element the paragraphs sit in. */
  root: RefObject<HTMLElement | null>;
  /** Words in each paragraph, in order. */
  sizes: number[];
  /** Paragraphs that must be drawn wherever the view is (the playhead's word, a selection's end), or null. */
  keep?: (number | null)[];
  render: (index: number) => ReactNode;
};

export function EditWindowedParagraphs({ root, sizes, keep = [], render }: Props) {
  const pages = useMemo(() => {
    const out: [number, number][] = [];
    let start = 0, words = 0;
    sizes.forEach((size, index) => {
      words += size;
      if (words >= PAGE_WORDS) { out.push([start, index + 1]); start = index + 1; words = 0; }
    });
    if (start < sizes.length) out.push([start, sizes.length]);
    return out;
  }, [sizes]);
  const [seen, setSeen] = useState<Set<number>>(() => new Set(Array.from({ length: FIRST_PAGES }, (_, index) => index)));
  const heights = useRef(new Map<number, number>());
  const elements = useRef(new Map<number, HTMLElement>());
  const observers = useRef<{ view: IntersectionObserver | null; size: ResizeObserver | null }>({ view: null, size: null });

  useEffect(() => {
    const view = new IntersectionObserver((entries) => setSeen((prior) => {
      let next: Set<number> | null = null;
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.editPage);
        if (entry.isIntersecting === prior.has(page)) continue;
        next ??= new Set(prior);
        if (entry.isIntersecting) next.add(page); else next.delete(page);
      }
      return next ?? prior;
    }), { root: root.current, rootMargin: `${DRAW_AHEAD_PX}px 0px` });
    const size = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target.dataset.editDrawn === "true") heights.current.set(Number(target.dataset.editPage), entry.contentRect.height);
      }
    });
    observers.current = { view, size };
    for (const element of elements.current.values()) { view.observe(element); size.observe(element); }
    return () => { view.disconnect(); size.disconnect(); observers.current = { view: null, size: null }; };
  }, [root]);

  // One stable ref per page: a new callback each render would have React
  // detach and reattach every page, and the observers with them.
  const attach = useCallback((page: number, element: HTMLElement | null) => {
    const { view, size } = observers.current;
    const previous = elements.current.get(page);
    if (previous && previous !== element) { view?.unobserve(previous); size?.unobserve(previous); elements.current.delete(page); }
    if (element && previous !== element) { elements.current.set(page, element); view?.observe(element); size?.observe(element); }
  }, []);
  const count = pages.length;
  const refs = useMemo(() => Array.from({ length: count }, (_, page) => (element: HTMLElement | null) => attach(page, element)), [count, attach]);
  // Computed once per layout, not on every render: the record re-renders each
  // time the playhead reaches a new word, and a whole 50-mic sequence is over
  // a thousand pages.
  const estimates = useMemo(() => pages.map(([start, end]) => sizes.slice(start, end).reduce((sum, size) => sum + size * PX_PER_WORD + PX_PER_PARAGRAPH, 0)), [pages, sizes]);

  const pageOf = (paragraph: number) => {
    let low = 0, high = pages.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1, [start, end] = pages[middle];
      if (paragraph < start) high = middle - 1; else if (paragraph >= end) low = middle + 1; else return middle;
    }
    return -1;
  };
  const kept = new Set(keep.filter((paragraph): paragraph is number => paragraph != null && paragraph >= 0).map(pageOf));
  return <>{pages.map(([start, end], page) => {
    const drawn = seen.has(page) || kept.has(page);
    const estimate = estimates[page];
    return <div key={page} ref={refs[page]} className="cp-te-textpage" data-edit-page={page} data-edit-drawn={drawn}
      style={drawn ? undefined : { height: heights.current.get(page) ?? estimate }}>
      {drawn && Array.from({ length: end - start }, (_, offset) => render(start + offset))}
    </div>;
  })}</>;
}
