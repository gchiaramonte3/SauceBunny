// Frame-accurate HH:MM:SS:FF timecodes. Falls back gracefully to HH:MM:SS.

const pad = (n: number, w = 2) => n.toString().padStart(w, "0");

export function framesToTc(frames: number, fps: number): string {
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
export function secondsToHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
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
  opts: { padMinutes?: boolean; forceHours?: boolean } = {},
): string {
  const s = Math.max(0, Math.floor(seconds));
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
