// Frame-accurate HH:MM:SS:FF timecodes. Falls back gracefully to HH:MM:SS.

const pad = (n: number, w = 2) => n.toString().padStart(w, "0");

export function framesToTc(frames: number, fps: number): string {
  // `Math.max(0, Math.floor(x))` LOOKS like a clamp and is not one for
  // non-finite input: floor(NaN) is NaN and max(0, NaN) is NaN, so the whole
  // string came out "NaN:NaN:NaN:NaN", and Infinity gave
  // "Infinity:NaN:NaN:NaN". `durationToTc` below already guards this way; the
  // same fix went into secondsToHms and secondsToClock earlier and simply
  // missed these two, which is why only they still printed it.
  //
  // Reachable rather than theoretical: fps rides in queue items restored from
  // localStorage and in metadata that has no fps of its own, and a single NaN
  // there turns every mark, log line and recent-clip duration into that
  // string.
  if (!isFinite(frames) || !isFinite(fps)) return "00:00:00:00";
  const f = Math.max(0, Math.floor(frames));
  const r = Math.max(1, Math.round(fps));
  const total = Math.floor(f / r);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const ff = f % r;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export function tcToFrames(tc: string, fps: number): number | null {
  const parts = tc.trim().split(":");
  if (!parts.length || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }
  while (nums.length < 4) nums.unshift(0);
  const [h, m, s, f] = nums;
  if (m >= 60 || s >= 60) return null;
  const r = Math.max(1, Math.round(fps));
  if (f >= r) return null;
  return ((h * 3600 + m * 60 + s) * r) + f;
}

export function tcToSeconds(tc: string, fps: number): number | null {
  const f = tcToFrames(tc, fps);
  if (f == null) return null;
  return f / Math.max(1, fps);
}

export function secondsToTc(seconds: number, fps: number): string {
  const r = Math.max(1, Math.round(fps));
  return framesToTc(Math.floor(seconds * r), fps);
}

export function durationToTc(durationSec: number | null, fps: number): string {
  if (durationSec == null || !isFinite(durationSec)) return "00:00:00:00";
  return secondsToTc(durationSec, fps);
}

// Coarse HH:MM:SS for ruler labels.
/**
 * Seconds → a safe whole number of seconds, for the formatters below.
 *
 * The non-finite case is not defensive padding. `<video>.duration` is NaN
 * until metadata arrives and Infinity for an unbounded stream, and both of
 * those reach these formatters through ordinary duration displays — so
 * `Math.max(0, Math.floor(x))` was printing "NaN:NaN" and
 * "Infinity:NaN:NaN" into the UI. ReaderPlayerStage carried its own copy of
 * this clock WITH an isFinite guard, which is how we know somebody met it;
 * the guard just never made it back to the shared function the other twelve
 * files call.
 *
 * Unknown reads as zero rather than a dash because that is what the local
 * copy already did, so adopting it changes nothing on screen. A distinct
 * "--:--" for unknown would be a better UI and is a design decision, not a
 * bug fix.
 */
function wholeSeconds(seconds: number, round: boolean): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, round ? Math.round(seconds) : Math.floor(seconds));
}

export function secondsToHms(seconds: number): string {
  const s = wholeSeconds(seconds, false);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Canonical human clock formatter: "M:SS" (or "MM:SS" with `padMinutes`),
 * rolling to "H:MM:SS" past an hour — or always with `forceHours`, so e.g. a
 * chapter list keeps one shape across all its lines. Negative input clamps
 * to zero. Distinct from secondsToHms, which always emits fully padded
 * "HH:MM:SS" ruler labels.
 */
export function secondsToClock(
  seconds: number,
  opts: { padMinutes?: boolean; forceHours?: boolean; round?: boolean } = {},
): string {
  // `round` exists for DURATION labels, which is a different job from a
  // playhead clock. A 59.7s clip reading "0:59" looks like a rounding bug on a
  // shelf card; a playhead flooring to 0:59 is correct, because the 60th
  // second has not finished. Both local copies of this function had already
  // chosen rounding for duration and flooring for the transport.
  const s = wholeSeconds(seconds, !!opts.round);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (opts.forceHours || h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${opts.padMinutes ? pad(m) : m}:${pad(sec)}`;
}

/** Parse a coarse "m:ss" / "h:mm:ss" (or bare "ss") string to seconds. Returns
 *  null on malformed input. Used to make the AI summary's [m:ss] timecodes
 *  clickable (seek-to-region) and, via chapters.ts, to read the LLM's chapter
 *  lines. `permissiveMinutes` relaxes the minutes<60 check for the TWO-part
 *  form only ("90:00" = 90 minutes — a legal chapter timestamp); the
 *  three-part form always demands real clock fields. */
export function hmsToSeconds(
  hms: string,
  opts: { permissiveMinutes?: boolean } = {},
): number | null {
  const parts = hms.trim().split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }
  const twoPart = parts.length === 2;
  while (nums.length < 3) nums.unshift(0);
  const [h, m, s] = nums;
  if (s >= 60) return null;
  if (m >= 60 && !(opts.permissiveMinutes && twoPart)) return null;
  return h * 3600 + m * 60 + s;
}

export function isValidTc(tc: string, fps: number): boolean {
  return tcToFrames(tc, fps) !== null;
}

export function normalizeTc(tc: string, fps: number): string {
  const f = tcToFrames(tc, fps);
  return f == null ? tc : framesToTc(f, fps);
}

/**
 * The transport HUD's digit entry, which is a DIFFERENT problem from
 * `tcToFrames` above and deliberately answers it differently.
 *
 * `tcToFrames` parses a timecode someone typed in full and VALIDATES it:
 * `00:99:99:99` is not a timecode, so it returns null and the caller refuses.
 * The HUD is the opposite. Digits arrive one at a time and fill right-to-left,
 * so every intermediate state is nonsense on the way to something real - "1"
 * is 00:00:00:01 before it becomes "130" is 00:00:01:30 - and there is nothing
 * to reject, only a position to land on. Overflow NORMALISES the way an NLE's
 * timecode field does: 90 frames at 24fps is three seconds and eighteen frames,
 * not an error.
 *
 * Both behaviours are correct for their own caller, which is exactly why they
 * sit next to each other here. They were 400 lines apart before, one of them
 * inlined in App.tsx with no test, and the risk was somebody noticing the
 * "missing" validation and helpfully adding it - which would make a half-typed
 * timecode unenterable.
 */

/** Digits typed so far (right-to-left into HHMMSSFF) → the frame they mean. */
export function tcDigitsToFrames(digits: string, fps: number): number {
  const d = (digits || "0").slice(-8).padStart(8, "0");
  const r = Math.max(1, Math.round(fps));
  const hh = +d.slice(0, 2), mm = +d.slice(2, 4), ss = +d.slice(4, 6), ff = +d.slice(6, 8);
  return ((hh * 3600 + mm * 60 + ss) * r) + ff;
}

/** Digits typed so far → the HH:MM:SS:FF the HUD paints. */
export function tcDigitsToDisplay(digits: string): string {
  const d = digits.slice(-8).padStart(8, "0");
  return `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}:${d.slice(6, 8)}`;
}
