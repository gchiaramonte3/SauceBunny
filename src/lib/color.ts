/**
 * Pure colour-space helpers for the hand-rolled speaker colour picker.
 *
 * No dependencies — HSV is the picker's source of truth (storing hex would
 * collapse hue when value/saturation hit an edge: the "drag to black and lose
 * your hue" bug). Hex/RGB are derived for display and parsed on input.
 *
 * Conventions: h ∈ [0,360)  s,v ∈ [0,1]  r,g,b ∈ [0,255].
 */

export type Rgb = { r: number; g: number; b: number };
export type Hsv = { h: number; s: number; v: number };

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** HSV → RGB (0–255). Used to render the preview, thumb, and emit hex. */
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s; // chroma
  const hp = (((h % 360) + 360) % 360) / 60; // hue sector 0..6, wrapped
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return { r: clamp255((r + m) * 255), g: clamp255((g + m) * 255), b: clamp255((b + m) * 255) };
}

/** RGB (0–255) → HSV. Used when parsing a typed hex or a preset swatch. */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

const toHex2 = (n: number) => clamp255(n).toString(16).padStart(2, "0");

/** RGB → "#rrggbb" (lowercase). */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

/** Convenience: HSV → "#rrggbb". */
export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));

/**
 * Parse "#rgb" / "#rrggbb" (with or without leading #). Returns null on
 * invalid input so callers can keep the last valid colour.
 */
export function parseHex(input: string): Rgb | null {
  let s = input.trim().replace(/^#/, "").toLowerCase();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return null;
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/** Relative luminance 0..1 — pick black vs white overlay/stroke on a swatch. */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** True when dark text reads better than white on this background. */
export const prefersDarkText = (hex: string): boolean => {
  const rgb = parseHex(hex);
  return rgb ? luminance(rgb) > 0.55 : false;
};

/**
 * Curated 12-swatch palette — even hue spacing, uniform chroma, tuned to read
 * as small pips on a near-black surface (Open Color "5" family). Doubles as the
 * default speaker rotation so manual and auto colours share one vocabulary.
 */
export const SPEAKER_PRESETS: readonly string[] = [
  "#FF6B6B", // coral
  "#FFA94D", // amber
  "#FFD43B", // gold
  "#A9E34B", // lime
  "#51CF66", // green
  "#20C997", // teal
  "#22B8CF", // cyan
  "#4DABF7", // blue
  "#748FFC", // indigo
  "#9775FA", // violet
  "#DA77F2", // magenta
  "#F783AC", // pink
];
