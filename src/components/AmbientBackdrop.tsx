import { useEffect, useRef, useState } from "react";
import { listThumbs, subscribeThumbs } from "../hooks/use-library-scan";

/** Quiet ambient timing — long dwell, long dissolve (the CSS owns the fade). */
const CYCLE_MS = 14_000;
const MIN_THUMBS = 3;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

type Props = {
  /** Home is the active view. Cycling pauses (interval cleared) when false —
   *  the view stays mounted ([hidden]) so the timer must not keep firing. */
  active: boolean;
};

function shuffle(list: string[]): string[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Apple-TV-quiet montage of the user's OWN already-cached posters beneath
 * Home's SHELVES (rendered inside .cp-lib-rows — never behind the hero, which
 * owns its art and must dissolve into flat bg-0). Two stacked, blurred layers
 * cross-dissolve every ~14s; only frames the library cards have already
 * materialized feed it — listThumbs() is a pure read of the shared thumbnail
 * cache, so the backdrop never triggers a decode or scan. Renders nothing
 * until at least three posters exist. Purely decorative: aria-hidden,
 * pointer-events:none, under the rows' content. Reduced motion → one static
 * frame, no cycle, no drift.
 */
export function AmbientBackdrop({ active }: Props) {
  const reduce = reducedMotion.matches;
  // Re-read on cache growth: cards materialize posters after we first render, and
  // our parent doesn't re-render for that — this subscription pulls new frames in
  // (and lets a cold start cross MIN_THUMBS so cycling can begin). Cheap read.
  const [, bump] = useState(0);
  useEffect(() => subscribeThumbs(() => bump((n) => n + 1)), []);
  const thumbs = listThumbs();
  const enough = thumbs.length >= MIN_THUMBS;

  // Two stacked layers; `top` (0|1) is the visible one. Advancing loads the NEXT
  // frame into the hidden layer, then flips `top` so CSS cross-fades to it.
  const [state, setState] = useState<{ layers: [string, string]; top: 0 | 1 }>(() => {
    const first = listThumbs()[0] ?? "";
    return { layers: [first, first], top: 0 };
  });

  // Shuffled queue of upcoming frames + the on-screen url, so successive picks
  // walk a shuffled order and never immediately repeat.
  const queue = useRef<string[]>([]);
  const frontUrl = useRef<string>(state.layers[state.top]);

  // Cold start: the initializer above ran while the cache was still empty, so
  // seed the visible frame the moment posters exist — otherwise both layers show
  // a blank src until the first ~14s tick. Idempotent once a frame is showing.
  useEffect(() => {
    if (thumbs.length === 0) return;
    setState((s) => {
      if (s.layers[s.top]) return s;
      const first = thumbs[0];
      frontUrl.current = first;
      return { layers: [first, first], top: s.top };
    });
    // thumbs.length stands in for "cache became non-empty"; re-seeding is guarded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thumbs.length]);

  // Pause when the tab/window is backgrounded, alongside `active`. Tracked in
  // state so the interval effect tears down + rebuilds when any pause flips.
  const [docVisible, setDocVisible] = useState(!document.hidden);
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const cycling = active && docVisible && enough && !reduce;

  useEffect(() => {
    if (!cycling) return;
    const nextUrl = (): string | null => {
      const pool = listThumbs(); // live re-read: newly-cached posters join in
      if (pool.length < MIN_THUMBS) return null;
      if (queue.current.length === 0) queue.current = shuffle(pool);
      let url = queue.current.shift();
      if (url === frontUrl.current && queue.current.length > 0) {
        queue.current.push(url); // defer the repeat, take the next frame
        url = queue.current.shift();
      }
      return url ?? null;
    };
    const id = window.setInterval(() => {
      const url = nextUrl();
      if (!url) return;
      frontUrl.current = url;
      setState((s) => {
        const top = (s.top ^ 1) as 0 | 1;
        const layers: [string, string] = top === 0 ? [url, s.layers[1]] : [s.layers[0], url];
        return { layers, top };
      });
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [cycling]);

  if (!enough) return null;

  // Reduced motion: a single still frame, no second layer, no drift/dissolve.
  if (reduce) {
    return (
      <div className="cp-lib-ambient" aria-hidden="true">
        <img className="cp-lib-ambient-layer on" src={thumbs[0]} alt="" draggable={false} />
        <div className="cp-lib-ambient-veil" />
      </div>
    );
  }

  return (
    <div className="cp-lib-ambient" aria-hidden="true">
      <img
        className={"cp-lib-ambient-layer" + (state.top === 0 ? " on" : "")}
        src={state.layers[0] || undefined}
        alt=""
        draggable={false}
      />
      <img
        className={"cp-lib-ambient-layer" + (state.top === 1 ? " on" : "")}
        src={state.layers[1] || undefined}
        alt=""
        draggable={false}
      />
      <div className="cp-lib-ambient-veil" />
    </div>
  );
}
