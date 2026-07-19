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
  const data = new Uint8Array(analyser.frequencyBinCount);
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
    // The peak-hold marker sits on the highest segment the hold level
    // reaches (-1 = silence, no marker).
    const holdIdx = holdLevel > 0.02 ? Math.min(n - 1, Math.floor(holdLevel * n)) : -1;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      if (!b) continue;
      b.classList.toggle("lit", level >= (i + 0.5) / n);
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
