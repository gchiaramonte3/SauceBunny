import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronLeft, IconChevronRight } from "./Icons";
import { scrollBehavior } from "../lib/motion";

type Props = {
  title: string;
  /** Playable-item count shown after the title. */
  count?: number;
  /** Hover-revealed "×" in the header — root rows only. Confirm + the
   *  actual forget live upstream in LibraryView; disk is never touched. */
  onRemove?: () => void;
  removeLabel?: string;
  children: ReactNode;
};

/**
 * One horizontal library shelf: header (title · count · optional remove),
 * an edge-faded track with native trackpad/touch scrolling (scrollbar
 * hidden), hover arrows that page by ~one viewport, and a WAI-ARIA roving
 * tabindex so the whole row is a single Tab stop with ←/→/Home/End walking
 * the cards. The roving logic is DOM-driven (queries .cp-lib-card inside
 * the track) so heterogeneous children — item cards and folder collections
 * — need no index props threaded through.
 */
export function LibraryRow({ title, count, onRemove, removeLabel, children }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(0);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const cards = () =>
    Array.from(trackRef.current?.querySelectorAll<HTMLElement>(".cp-lib-card") ?? []);

  const setActive = (list: HTMLElement[], idx: number) => {
    activeRef.current = idx;
    list.forEach((c, i) => { c.tabIndex = i === idx ? 0 : -1; });
  };

  const measure = () => {
    const el = trackRef.current;
    if (!el) return;
    // setState bails on identical values, so calling this every commit is free.
    setCanLeft(el.scrollLeft > 2);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };

  // After every commit: exactly one tabbable card (cards mount/unmount as
  // scans, searches, and thumbnails change) + fresh edge state. Idempotent
  // and cheap — a querySelectorAll over this row's buttons.
  useEffect(() => {
    const list = cards();
    if (activeRef.current >= list.length) activeRef.current = Math.max(0, list.length - 1);
    setActive(list, activeRef.current);
    measure();
  });

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, []);

  const page = (dir: 1 | -1) => {
    const el = trackRef.current;
    el?.scrollBy({ left: dir * Math.round(el.clientWidth * 0.9), behavior: scrollBehavior() });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const list = cards();
    const cur = list.indexOf(document.activeElement as HTMLElement);
    if (list.length === 0 || cur < 0) return;
    e.preventDefault();
    const next =
      e.key === "ArrowLeft" ? Math.max(0, cur - 1) :
      e.key === "ArrowRight" ? Math.min(list.length - 1, cur + 1) :
      e.key === "Home" ? 0 : list.length - 1;
    setActive(list, next);
    list[next].focus(); // the browser scrolls it into the track's view
  };

  // Clicking or Tab-bing onto a card adopts it as the roving stop.
  const adoptFocus = (e: React.FocusEvent) => {
    const list = cards();
    const i = list.indexOf(e.target as HTMLElement);
    if (i >= 0 && i !== activeRef.current) setActive(list, i);
  };

  return (
    <section className="cp-lib-row">
      <div className="cp-lib-row-head">
        <h2 className="cp-lib-row-title">{title}</h2>
        {count != null && <span className="cp-lib-row-count">{count}</span>}
        {onRemove && (
          <button
            type="button"
            className="cp-lib-row-remove"
            title={removeLabel ?? "Remove from library"}
            aria-label={removeLabel ?? "Remove from library"}
            onClick={onRemove}
          >
            ×
          </button>
        )}
      </div>
      <div className="cp-lib-row-body">
        {canLeft && (
          <button type="button" className="cp-lib-row-arrow left" tabIndex={-1}
            aria-hidden="true" onClick={() => page(-1)}>
            <IconChevronLeft size={20} />
          </button>
        )}
        <div
          ref={trackRef}
          role="list"
          aria-label={title}
          className={"cp-lib-track" + (canLeft ? " fade-l" : "") + (canRight ? " fade-r" : "")}
          onKeyDown={onKeyDown}
          onFocusCapture={adoptFocus}
        >
          {children}
        </div>
        {canRight && (
          <button type="button" className="cp-lib-row-arrow right" tabIndex={-1}
            aria-hidden="true" onClick={() => page(1)}>
            <IconChevronRight size={20} />
          </button>
        )}
      </div>
    </section>
  );
}
