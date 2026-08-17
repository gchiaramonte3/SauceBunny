// Lightweight UI sound effects synthesised via Web Audio API.
// No external audio file needed — works offline, zero bundle weight.

let ctxRef: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctxRef) return ctxRef;
  // Safari < 14 exposed AudioContext under the `webkitAudioContext`
  // prefix. Narrow just that one property instead of dropping to `any`.
  const webkitCtor = (window as { webkitAudioContext?: typeof AudioContext })
    .webkitAudioContext;
  const Ctor: typeof AudioContext | undefined = window.AudioContext ?? webkitCtor;
  if (!Ctor) return null;
  try {
    ctxRef = new Ctor();
  } catch {
    ctxRef = null;
  }
  // WKWebView starts an AudioContext created OUTSIDE a user gesture in the
  // "suspended" state, where scheduling an oscillator succeeds and produces
  // silence. Every cue here fires from an async completion - an export
  // finishing, a transcript landing - never from a click, so this context was
  // always born suspended. And because ctxRef caches it for the life of the
  // page, nothing later could rescue it: the app simply had no sounds.
  //
  // level-meter.ts and PeoplePanel.tsx both carry this same lesson in their
  // own comments. This module predates neither of them; it just never got it.
  // resume() is a no-op on a running context, so it is called unconditionally.
  if (ctxRef && ctxRef.state === "suspended") void ctxRef.resume();
  return ctxRef;
}

/** Play one tone with a soft attack + exponential decay envelope. */
function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", peak = 0.15) {
  const ctx = getCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Two-note ascending chime — A5 → E6. Mac "Glass"-adjacent. */
export function playSuccess() {
  tone(880,    0.00, 0.22, "sine", 0.18);
  tone(1318.5, 0.10, 0.32, "sine", 0.14);
}

/** Two-note descending buzz for failures - A3 down to E3. */
export function playError() {
  tone(220, 0.00, 0.40, "triangle", 0.10);
  tone(165, 0.08, 0.32, "triangle", 0.08);
}

/** Subtle click for neutral confirmations. */
export function playInfo() {
  tone(660, 0.00, 0.10, "sine", 0.08);
}
