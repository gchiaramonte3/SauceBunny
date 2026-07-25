import { useEffect, useRef, useState } from "react";
import { listThumbPaths, requestHeroStill, subscribeThumbs } from "../hooks/use-library-scan";

/**
 * Ambient montage for the Home hero's art slot: a slow wander through one
 * band-resolution still per library video that already has a cached poster.
 * Sits ON TOP of LibraryHero's static backdrop (same geometry, under the
 * shade), so until the first flip lands — and whenever the library is too
 * small to wander — the hero looks exactly as it always did.
 *
 * Grammar (user-specified): a very long cross-dissolve between random frames,
 * plus a barely-there scale drift that alternates direction — one frame eases
 * 100% → 103% while the next arrives at 103% and settles back to 100% — so
 * the corner is never fully still. CSS owns both (see .cp-hero-cycle in
 * library.css); this component only decides WHAT shows and WHEN to flip.
 *
 * Discipline (keep-alive views): the flip timer runs only while Home is the
 * active view, one hero-resolution decode per flip rides the shared decode
 * gate, and the two on-screen layers are always the most recent requests, so
 * the hero LRU can never revoke a frame that is still visible. Reduced motion
 * renders nothing — the static hero already serves that preference.
 */

/** One flip per cycle; the CSS dissolve is 20s, so ~10s fully settled. */
const CYCLE_MS = 30_000;
/** First flip lands soon after arriving on Home — the wander should be
 *  noticeable without waiting out a whole cycle. */
const FIRST_FLIP_MS = 4_000;
/** Below this many distinct frames a montage just flickers between the same
 *  two stills; stay on the static hero instead. */
const MIN_FRAMES = 3;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function shuffle(list: string[]): string[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Layer = { url: string; seq: number };

type Props = {
  /** Home is the active view. The flip timer pauses (cleared) when false —
   *  the view stays mounted ([hidden]) so it must not keep working. */
  active: boolean;
};

export function HeroMontage({ active }: Props) {
  const reduce = reducedMotion.matches;
  // Track cache growth so a cold boot can cross MIN_FRAMES and start.
  const [, bump] = useState(0);
  useEffect(() => subscribeThumbs(() => bump((n) => n + 1)), []);
  const enough = listThumbPaths().length >= MIN_FRAMES;

  // Two stacked layers; `top` is the incoming/visible one. Each arrival gets
  // a fresh seq: it keys the <img> (a remount restarts the scale-drift
  // animation) and its parity picks the drift direction — even eases in
  // toward 103%, odd arrives at 103% and settles out to 100%.
  const [state, setState] = useState<{ layers: [Layer, Layer]; top: 0 | 1 }>({
    layers: [{ url: "", seq: 0 }, { url: "", seq: 1 }],
    top: 0,
  });
  // A freshly mounted <img> can't transition INTO `show` (transitions don't
  // run on initial styles), so the raise happens one frame after commit:
  // `show` = mounted-and-risen, and everything below shownSeq fades out.
  const [shownSeq, setShownSeq] = useState(-1);
  useEffect(() => {
    const seq = state.layers[state.top].seq;
    const id = requestAnimationFrame(() => setShownSeq(seq));
    return () => cancelAnimationFrame(id);
  }, [state]);

  const queueRef = useRef<string[]>([]);
  const seqRef = useRef(2);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!active || !enough || reduce) return;
    const tick = async () => {
      if (busyRef.current) return; // last flip's decode still in flight
      busyRef.current = true;
      try {
        // Reshuffle whenever the walk runs dry — posters the user's browsing
        // has materialized since simply join the next lap.
        if (queueRef.current.length === 0) queueRef.current = shuffle(listThumbPaths());
        const path = queueRef.current.shift();
        if (!path) return;
        const url = await requestHeroStill(path);
        if (!url || !aliveRef.current) return;
        setState((s) => {
          const hidden: 0 | 1 = s.top === 0 ? 1 : 0;
          const layers: [Layer, Layer] = [s.layers[0], s.layers[1]];
          layers[hidden] = { url, seq: seqRef.current++ };
          return { layers, top: hidden };
        });
      } finally {
        busyRef.current = false;
      }
    };
    const first = window.setTimeout(() => void tick(), FIRST_FLIP_MS);
    const iv = window.setInterval(() => void tick(), CYCLE_MS);
    return () => { window.clearTimeout(first); window.clearInterval(iv); };
  }, [active, enough, reduce]);

  if (reduce || !enough) return null;

  return (
    <>
      {state.layers.map((layer, i) =>
        layer.url ? (
          <img
            key={layer.seq}
            className={
              "cp-lib-hero-bg cp-hero-cycle" +
              (i === state.top && layer.seq <= shownSeq ? " show" : "") +
              (layer.seq % 2 === 0 ? " kb-in" : " kb-out")
            }
            src={layer.url}
            alt=""
            aria-hidden
            draggable={false}
          />
        ) : null,
      )}
    </>
  );
}
