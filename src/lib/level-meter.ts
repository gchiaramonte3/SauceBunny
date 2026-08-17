/**
 * Shared mic level meter driver (green room + Settings > Camera & Mic).
 *
 * Lights a horizontal strip of segment elements from a live MediaStream:
 * time-domain peak per frame, segments lit left to right, with a brief
 * peak-hold marker (the broadcast-meter affordance that makes "how hot am
 * I" readable at a glance). Colors live in CSS zone classes (green body,
 * yellow hot, red peaking) - a level meter is live signal feedback, so the
 * green/yellow/red convention applies, not the grey-chip rule.
 *
 * Two WKWebView lessons baked in:
 *  - An AudioContext created OUTSIDE a user gesture starts "suspended" and
 *    reads flat silence forever - the auto-started Settings preview hit
 *    exactly this ("the bars never move"). resume() is allowed once a live
 *    getUserMedia stream exists, so call it unconditionally.
 *  - prefers-reduced-motion must NOT disable the meter: it's essential
 *    feedback, not decoration. The CSS drops transitions instead.
 */

/**
 * The highest segment index lit by `level`, or -1 for "nothing lit".
 *
 * ONE quantiser, used for both the lit run and the peak-hold marker, because
 * using two was the bug. A segment lights at its MIDPOINT (`level >= (i+0.5)/n`)
 * — that is what makes a half-lit-looking strip read honestly — while the hold
 * marker used to bucket at a segment's LOWER edge (`Math.floor(level * n)`).
 * For 46 of the 128 reachable peak values those disagree by exactly one, always
 * in the same direction, so the marker sat one segment ABOVE the signal.
 *
 * It crossed zone boundaries, which is what made it more than cosmetic: a peak
 * of 84 (≈ -3.6 dBFS, an ordinary loud speaking voice) lit up to bar 13, the
 * last yellow, while the marker landed on bar 14 — red — and CSS paints `.hold`
 * at opacity 0.85 against `.zone-red { background: var(--danger) }`. The user
 * saw a near-solid red "peaking" bar with nothing red lit, on the exact strip
 * the Settings copy tells them to watch.
 *
 * `holdLevel` is assigned `= level` on any rising frame, so on the peak frame
 * the two are equal and the marker must coincide with the top of the lit run.
 * The offset could never be explained away as hold decay.
 *
 * Deriving both from this function makes the disagreement unrepresentable.
 * It also retires the separate `holdLevel > 0.02` silence gate: the marker now
 * appears exactly when the first segment lights, rather than at a second,
 * slightly lower threshold of its own.
 */
export function topLitIndex(level: number, n: number): number {
  // Non-finite means we do not know the level, so paint nothing rather than
  // guess at either end. Unreachable from the analyser (peak comes from a
  // Uint8Array, so `peak / 96` is always finite) but the contract below is
  // then true for every input rather than every expected input.
  if (!Number.isFinite(level) || n <= 0) return -1;
  // Highest i satisfying level >= (i + 0.5) / n  ⟺  i <= level * n - 0.5.
  // Clamped BOTH ends: the result is an index into the strip or -1, never the
  // -9 that a negative level would otherwise produce. Callers compare with
  // `i <= topLit` and `i === holdIdx`, where -9 behaves like -1 today — but a
  // function whose doc says "-1" should return -1.
  return Math.max(-1, Math.min(n - 1, Math.floor(level * n - 0.5)));
}

export function startLevelMeter(
  stream: MediaStream,
  getBars: () => (HTMLElement | null)[],
): () => void {
  if (stream.getAudioTracks().length === 0) return () => {};
  const ctx = new AudioContext();
  // See doc comment: suspended contexts read silence. Safe no-op when running.
  if (ctx.state === "suspended") void ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  // fftSize, NOT frequencyBinCount. getByteTimeDomainData fills fftSize
  // samples and DROPS the excess when the array is shorter;
  // frequencyBinCount is fftSize/2 and is the right size for
  // getByteFrequencyData instead. Sized at 128 this read only the first
  // half of each 256-sample window, so a transient in the second half
  // never reached the peak scan and the meter under-read.
  const data = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let holdLevel = 0;
  let holdUntil = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
    const level = Math.min(1, peak / 96);
    const now = performance.now();
    if (level >= holdLevel || now >= holdUntil) {
      holdLevel = level;
      holdUntil = now + 900; // classic ~1s peak hold, then release
    }
    const bars = getBars();
    const n = bars.length;
    // Both derived from the SAME quantiser - see topLitIndex. -1 is silence,
    // and it now falls out of the maths rather than a separate threshold.
    const topLit = topLitIndex(level, n);
    const holdIdx = topLitIndex(holdLevel, n);
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      if (!b) continue;
      b.classList.toggle("lit", i <= topLit);
      b.classList.toggle("hold", i === holdIdx);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    // Clear the strip so a stopped meter doesn't freeze mid-signal.
    for (const b of getBars()) b?.classList.remove("lit", "hold");
    src.disconnect();
    void ctx.close();
  };
}

/** Segment count + zone class for the shared meter strip. 16 segments:
 *  10 green (normal), 4 yellow (hot), 2 red (peaking). */
export const METER_SEGMENTS = 16;
export function meterZoneClass(i: number): string {
  if (i >= 14) return "cp-gr-meter-bar zone-red";
  if (i >= 10) return "cp-gr-meter-bar zone-yellow";
  return "cp-gr-meter-bar zone-green";
}
