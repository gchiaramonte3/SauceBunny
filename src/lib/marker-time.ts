// Pure time-conversion core for exporting Review notes as NLE markers.
//
// The app knows *real playback seconds* (the corrected <video> playhead), but
// every NLE places markers by frame. Converting between the two needs TWO
// numbers per rate (see RATE_TABLE): `fpsExact` maps seconds -> the frame the
// reviewer actually saw, while `timebase` is the integer label base used to
// render HH:MM:SS:FF. For fractional NTSC rates they differ by ~0.1%, which is
// exactly the drift that lands "38.000 s" on 01:00:37:23 rather than
// 01:00:38:00 at 23.976 — correct, not a rounding bug.
//
// No serializers, no UI, no React here — just the numbers.

export type FrameRateKey =
  | "23.976"
  | "24"
  | "25"
  | "29.97"
  | "30"
  | "50"
  | "59.94"
  | "60";

export type MarkerExportSettings = {
  frameRate: FrameRateKey;
  /** Sequence Start TC (HH:MM:SS:FF). NLE timelines usually start at hour 1;
   *  web sources start at 0s, so this offset is added to every marker. */
  sequenceStartTc: string;
  /** Drop-frame timecode. Only honored at 29.97 / 59.94 (see RATE_TABLE). */
  dropFrame: boolean;
};

export const DEFAULT_MARKER_SETTINGS: MarkerExportSettings = {
  frameRate: "23.976",
  sequenceStartTc: "01:00:00:00",
  dropFrame: false,
};

export type Rational = { num: number; den: number };

export type RateSpec = {
  /** Seconds -> frame index. 23.976 = 24000/1001, integers are exact. */
  fpsExact: Rational;
  /** Integer label base T: the frames field runs 0…T-1 when rendering TC. */
  timebase: number;
  /** xmeml <ntsc> flag — true for the three fractional NTSC rates. */
  ntsc: boolean;
  /** Drop-frame legal? Only the two NTSC broadcast rates (29.97 / 59.94). */
  dropAllowed: boolean;
  /** FCPXML per-frame rational (num/den). A marker's rational numerator is
   *  always `frames * num`, which guarantees FCP's edit-frame-boundary rule. */
  frameDuration: Rational;
};

// One row per rate. fpsExact and frameDuration are reciprocals, kept side by
// side so both the seconds->frame and the FCPXML-rational paths read directly.
export const RATE_TABLE: Record<FrameRateKey, RateSpec> = {
  "23.976": { fpsExact: { num: 24000, den: 1001 }, timebase: 24, ntsc: true, dropAllowed: false, frameDuration: { num: 1001, den: 24000 } },
  "24":     { fpsExact: { num: 2400, den: 100 }, timebase: 24, ntsc: false, dropAllowed: false, frameDuration: { num: 100, den: 2400 } },
  "25":     { fpsExact: { num: 2500, den: 100 }, timebase: 25, ntsc: false, dropAllowed: false, frameDuration: { num: 100, den: 2500 } },
  "29.97":  { fpsExact: { num: 30000, den: 1001 }, timebase: 30, ntsc: true, dropAllowed: true, frameDuration: { num: 1001, den: 30000 } },
  "30":     { fpsExact: { num: 3000, den: 100 }, timebase: 30, ntsc: false, dropAllowed: false, frameDuration: { num: 100, den: 3000 } },
  "50":     { fpsExact: { num: 5000, den: 100 }, timebase: 50, ntsc: false, dropAllowed: false, frameDuration: { num: 100, den: 5000 } },
  "59.94":  { fpsExact: { num: 60000, den: 1001 }, timebase: 60, ntsc: true, dropAllowed: true, frameDuration: { num: 1001, den: 60000 } },
  "60":     { fpsExact: { num: 6000, den: 100 }, timebase: 60, ntsc: false, dropAllowed: false, frameDuration: { num: 100, den: 6000 } },
};


/** Every rate the export UI offers, in display order. */
export const FRAME_RATE_KEYS: FrameRateKey[] = ["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"];

/** Map a source fps to the closest FrameRateKey (within 0.2), so an export can
 *  pre-seed to the clip's real rate; null when nothing is close enough. */
export function fpsToRateKey(fps: number): FrameRateKey | null {
  const targets: Record<FrameRateKey, number> = {
    "23.976": 23.976, "24": 24, "25": 25, "29.97": 29.97, "30": 30, "50": 50, "59.94": 59.94, "60": 60,
  };
  let best: FrameRateKey | null = null;
  let bestD = 0.2;
  for (const k of FRAME_RATE_KEYS) {
    const d = Math.abs(fps - targets[k]);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

const pad = (n: number) => n.toString().padStart(2, "0");

/** 0-based frame index from media start: round(seconds × fpsExact). */
export function frameIndex(seconds: number, rate: FrameRateKey): number {
  const { num, den } = RATE_TABLE[rate].fpsExact;
  return Math.round((Math.max(0, seconds) * num) / den);
}

// --- Drop-frame timecode (canonical SMPTE, 29.97 / 59.94 only) --------------
// Standard algorithm: D dropped labels per minute except every 10th minute.
// D = round(T/15) → 2 @30, 4 @60.

function framesToDropTc(tf: number, T: number): string {
  const D = Math.round(T / 15);
  const framesPer10Min = T * 600 - 9 * D; // real frames in 10 minutes of DF TC
  const framesPerMin = T * 60 - D;
  const d = Math.floor(tf / framesPer10Min);
  const m = tf % framesPer10Min;
  const n =
    m > D
      ? tf + D * 9 * d + D * Math.floor((m - D) / framesPerMin)
      : tf + D * 9 * d;
  const ff = n % T;
  const ss = Math.floor(n / T) % 60;
  const mm = Math.floor(Math.floor(n / T) / 60) % 60;
  const hh = Math.floor(Math.floor(Math.floor(n / T) / 60) / 60);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)};${pad(ff)}`;
}

function dropTcToFrames(hh: number, mm: number, ss: number, ff: number, T: number): number {
  const D = Math.round(T / 15);
  const totalMinutes = 60 * hh + mm;
  return (
    T * 3600 * hh +
    T * 60 * mm +
    T * ss +
    ff -
    D * (totalMinutes - Math.floor(totalMinutes / 10))
  );
}

/** Parse HH:MM:SS:FF (or the DF ';' before frames) to absolute frames. Short
 *  forms pad from the left, matching the app's other timecode parsers. Returns
 *  null on malformed input or an out-of-range field. `dropFrame` is honored
 *  only where the rate allows it (else parsed as non-drop). */
export function tcToFrames(tc: string, rate: FrameRateKey, dropFrame: boolean): number | null {
  const spec = RATE_TABLE[rate];
  const T = spec.timebase;
  const parts = tc.trim().split(/[:;]/);
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }
  while (nums.length < 4) nums.unshift(0);
  const [hh, mm, ss, ff] = nums;
  if (mm >= 60 || ss >= 60 || ff >= T) return null;
  if (dropFrame && spec.dropAllowed) return dropTcToFrames(hh, mm, ss, ff, T);
  return (hh * 3600 + mm * 60 + ss) * T + ff;
}

/** Absolute frames -> HH:MM:SS:FF. Non-drop uses ':' throughout; drop-frame
 *  (29.97 / 59.94 only) uses ';' before the frames field. */
export function framesToTc(totalFrames: number, rate: FrameRateKey, dropFrame: boolean): string {
  const spec = RATE_TABLE[rate];
  const T = spec.timebase;
  const tf = Math.max(0, Math.round(totalFrames));
  if (dropFrame && spec.dropAllowed) return framesToDropTc(tf, T);
  const ff = tf % T;
  const totalSec = Math.floor(tf / T);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/** Absolute sequence frame for a playhead second = media-start frame index
 *  plus the Start-TC offset. */
export function totalFrames(seconds: number, settings: MarkerExportSettings): number {
  const start = tcToFrames(settings.sequenceStartTc, settings.frameRate, settings.dropFrame) ?? 0;
  return frameIndex(seconds, settings.frameRate) + start;
}

/** Span length in frames: round(out × fpsExact) − round(in × fpsExact). */
export function durationFrames(inSec: number, outSec: number, rate: FrameRateKey): number {
  return frameIndex(outSec, rate) - frameIndex(inSec, rate);
}

// --- FCPXML rational time ---------------------------------------------------
// Every numerator is `frames × frameDuration.num`, so `numerator %
// frameDuration.num === 0` and FCP never rejects the file for landing off an
// edit-frame boundary.

/** Frame count -> FCPXML rational string, e.g. 911 @23.976 -> "911911/24000s". */
export function framesToRational(frames: number, rate: FrameRateKey): string {
  const fd = RATE_TABLE[rate].frameDuration;
  return `${Math.round(frames) * fd.num}/${fd.den}s`;
}

/** Playhead seconds -> clip-local FCPXML rational (the marker `start`; the
 *  sequence's `tcStart` carries the Start-TC offset separately). */
export function secondsToRational(seconds: number, settings: MarkerExportSettings): string {
  return framesToRational(frameIndex(seconds, settings.frameRate), settings.frameRate);
}

/** Sequence Start TC as an FCPXML rational (the `tcStart` display offset). */
export function tcStartRational(settings: MarkerExportSettings): string {
  const start = tcToFrames(settings.sequenceStartTc, settings.frameRate, settings.dropFrame) ?? 0;
  return framesToRational(start, settings.frameRate);
}
