/** Audition gain only; never applied to AAF media or transcription input. */
export const TRACK_GAIN_MIN_DB = -60;
export const TRACK_GAIN_MAX_DB = 36;
export const TRACK_GAIN_OFF = TRACK_GAIN_MIN_DB - 1;
export const TRACK_GAIN_MAX = 10 ** (TRACK_GAIN_MAX_DB / 20);

export function clampTrackGain(gain: number): number {
  return Number.isFinite(gain) ? Math.max(0, Math.min(TRACK_GAIN_MAX, gain)) : 1;
}

/** The fader's bottom detent is silence, distinct from -60 dB attenuation. */
export function trackDbToGain(db: number): number {
  if (!Number.isFinite(db)) return 1;
  return db < TRACK_GAIN_MIN_DB ? 0 : 10 ** (Math.min(TRACK_GAIN_MAX_DB, db) / 20);
}

export function trackGainToDb(gain: number): number {
  const level = clampTrackGain(gain);
  return level === 0 ? TRACK_GAIN_OFF : Math.max(TRACK_GAIN_MIN_DB, 20 * Math.log10(level));
}

export function formatTrackGain(gain: number): string {
  if (clampTrackGain(gain) === 0) return "−∞ dB";
  const db = Math.round(trackGainToDb(gain) * 10) / 10;
  return `${db > 0 ? "+" : ""}${db} dB`;
}

/** No parseFloat prefix acceptance: '+10oops' must not change audible gain. */
export function parseTrackGain(text: string): number | null {
  const match = text.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:dB)?$/i);
  if (!match) return null;
  const db = Number(match[1]);
  return Number.isFinite(db) ? trackDbToGain(Math.max(TRACK_GAIN_MIN_DB, db)) : null;
}
