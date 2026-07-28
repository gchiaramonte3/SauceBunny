import { describe, expect, it } from "vitest";
import { SPEAKER_PALETTE, SPEAKER_UNASSIGNED } from "../components/transcript/helpers";
import { SPEAKER_PRESETS } from "./color";

/**
 * The speaker palette's contract, in the idiom focus-contract, csp-contract
 * and asset-scope-contract already establish here.
 *
 * This test is the actual deliverable of the palette work. The colours were
 * searched against three real surfaces rather than chosen by eye, and the one
 * that binds is not the panel — it is the on-video caption, where a white
 * frame under the default 0.75 black backing leaves only #404040 to sit on.
 * That is the surface the PREVIOUS palette failed, invisibly, because nobody
 * checks a caption against a white frame.
 *
 * So: do not add a nicer purple without running this.
 */
const PANEL = "#0E0E10";        // --bg-1, the transcript panel
const CAPTION_WORST = "#404040"; // white frame under rgba(0,0,0,0.75)
const PIP_INITIALS = "#0a0a0a";  // .cp-tx-speaker draws its initials in this
const BRAND_ACCENT = "#6CFF8D";

const rgb = (hex: string) => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** sRGB → CIELAB (D65), for ΔE00. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(lin);
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000. The perceptual distance that "these look the same" means. */
function deltaE00(x: string, y: string): number {
  const [L1, a1, b1] = lab(x);
  const [L2, a2, b2] = lab(y);
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * 180) / Math.PI % 360;
  const h2p = (Math.atan2(b2, a2p) * 180) / Math.PI % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2
      : h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const rad = (d: number) => (d * Math.PI) / 180;
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp))
    + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.20 * Math.cos(rad(4 * hbp - 63));
  const dth = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dth)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
    + Rt * (dCp / Sc) * (dHp / Sh));
}

describe("the speaker palette", () => {
  it("has twelve hues", () => {
    // Not an arbitrary number: roughly where categorical colour stops working
    // at pip size. d3 dropped schemeCategory20 for this reason, Premiere ships
    // sixteen labels, Avid eight. Past twelve the initials do the work.
    expect(SPEAKER_PALETTE).toHaveLength(12);
  });

  it("is readable on the transcript panel", () => {
    for (const c of SPEAKER_PALETTE) {
      expect(contrast(c, PANEL), `${c} on the panel`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is readable as a caption over a WHITE frame, at the default backing", () => {
    // The binding constraint, and the one the old palette failed. Gated at the
    // CURRENT 0.75 default on purpose: darkening everyone's captions to rescue
    // a colour would be fixing the wrong thing.
    for (const c of SPEAKER_PALETTE) {
      expect(contrast(c, CAPTION_WORST), `${c} as a caption on white`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(SPEAKER_UNASSIGNED, CAPTION_WORST)).toBeGreaterThanOrEqual(4.5);
  });

  it("carries legible initials inside the pip", () => {
    for (const c of SPEAKER_PALETTE) {
      expect(contrast(c, PIP_INITIALS), `initials on ${c}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps every member visibly distinct from every other", () => {
    // 14.5 is the measured ceiling once all three contrast bars and the accent
    // exclusion are honoured. Gated a little below it so the current set is not
    // sitting exactly on the line, but close enough that a careless swap fails.
    for (let i = 0; i < SPEAKER_PALETTE.length; i += 1) {
      for (let j = i + 1; j < SPEAKER_PALETTE.length; j += 1) {
        const d = deltaE00(SPEAKER_PALETTE[i], SPEAKER_PALETTE[j]);
        expect(d, `${SPEAKER_PALETTE[i]} vs ${SPEAKER_PALETTE[j]}`).toBeGreaterThanOrEqual(14);
      }
    }
  });

  it("never lets a speaker wear the brand accent", () => {
    // The accent means "this app's chrome". A speaker wearing it makes two
    // different things look like the same thing.
    for (const c of SPEAKER_PALETTE) {
      expect(deltaE00(c, BRAND_ACCENT), `${c} vs the accent`).toBeGreaterThanOrEqual(14);
    }
  });

  it("gives unassigned speech its own tone, clearly apart from every speaker", () => {
    // speakerColorIndex(null) used to return 0, so "unknown" wore the first
    // speaker's exact hue and read as a person.
    for (const c of SPEAKER_PALETTE) {
      expect(deltaE00(SPEAKER_UNASSIGNED, c)).toBeGreaterThanOrEqual(14);
    }
  });

  it("is the same list the colour picker offers", () => {
    // The picker used to have its OWN twelve, whose comment claimed it doubled
    // as the speaker rotation — untrue, and seven of them failed the caption
    // bar, so the picker offered colours that went unreadable the moment that
    // speaker talked over a bright frame.
    expect([...SPEAKER_PRESETS]).toEqual([...SPEAKER_PALETTE]);
  });

  it("contains no greys — every member is actually a colour", () => {
    // The palette deliberately refuses grey and black: they read as disabled
    // rather than as a person.
    for (const c of SPEAKER_PALETTE) {
      const [, a, b] = lab(c);
      expect(Math.hypot(a, b), `${c} chroma`).toBeGreaterThan(20);
    }
  });
});
