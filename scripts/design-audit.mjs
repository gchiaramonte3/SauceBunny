#!/usr/bin/env node
//
// Counts design-token OUTLIERS: literal values in the stylesheets that a
// token already covers. The migration drives this to zero minus the
// sanctioned list, and each commit records the number.
//
// Sanctioned values live in SANCTIONED below, each with the reason it is not
// drift. That list is the same one the vitest guards enforce; if the two ever
// disagree, the guards are the ones that fail a build.
//
//   node scripts/design-audit.mjs          # summary
//   node scripts/design-audit.mjs --list   # every location
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/styles";
// tokens.css DEFINES the values, base.css sets the one global font stack.
const TOKEN_FILES = new Set(["tokens.css", "base.css"]);
const LIST = process.argv.includes("--list");

/** Not drift. Each entry says why, and the guards carry the same list. */
const SANCTIONED = {
  // The visible spectrum in the colour picker's hue strip - a palette token
  // for "red" would be nonsense here.
  hueStrip: new Set(["#f00", "#ff0", "#0f0", "#0ff", "#00f", "#f0f"]),
  // A circle, not a step on a radius scale.
  circle: new Set(["50%"]),
};

/**
 * Neutral alphas over pure black or white are the app's FILL system, and
 * tokens.css already decided they keep their own values ("background FILL
 * alphas are a separate concern"). A scrim at 0.55 and a wash at 0.06 are
 * different intentions, not two spellings of one colour, and inventing a
 * token per alpha would be a worse file than the one we have.
 *
 * A COLOURED rgba is different: it is a tint of something the palette names,
 * and the palette should be where it comes from.
 */
function isNeutralAlpha(v) {
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return false;
  const [r, g, b] = m.slice(1).map(Number);
  return (r === g && g === b) && (r === 0 || r === 255);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".css"));
const out = {
  fontSize: [], fontWeight: [], fontFamily: [], lineHeight: [],
  letterSpacing: [], color: [], radius: [], zIndex: [], transition: [],
  fauxWeight: [],
};
/** The weights actually imported in src/main.tsx. */
const LOADED_WEIGHTS = new Set(["300", "400", "600", "700", "800", "normal", "bold", "inherit"]);

for (const f of files) {
  if (TOKEN_FILES.has(f)) continue;
  readFileSync(join(DIR, f), "utf8").split("\n").forEach((raw, i) => {
    const at = `${f}:${i + 1}`;
    const l = raw.replace(/\/\*.*?\*\//g, "");
    const lit = (v) => v && !v.startsWith("var(") && v !== "inherit" && v !== "initial";
    let m;
    // `font-size: 0` is the hide-the-text idiom, not a size, and em units
    // are deliberately relative to a user-set reader size.
    if ((m = l.match(/font-size:\s*([^;]+);/)) && lit(m[1].trim())
        && !/\dem\b/.test(m[1]) && m[1].trim() !== "0") {
      out.fontSize.push([at, m[1].trim()]);
    }
    if ((m = l.match(/font-weight:\s*([^;]+);/))) {
      const v = m[1].trim();
      if (lit(v)) out.fontWeight.push([at, v]);
      if (!LOADED_WEIGHTS.has(v) && !v.startsWith("var(")) out.fauxWeight.push([at, v]);
    }
    if ((m = l.match(/font-family:\s*([^;]+);/)) && lit(m[1].trim())) out.fontFamily.push([at, m[1].trim()]);
    // A var() with a hardcoded fallback is drift too: the token is always
    // defined, so the fallback is a second opinion nobody reads.
    if ((m = l.match(/font-family:\s*var\(--font-[a-z]+,\s*[^)]+\)/))) out.fontFamily.push([at, m[0]]);
    if ((m = l.match(/line-height:\s*([^;]+);/)) && lit(m[1].trim())) out.lineHeight.push([at, m[1].trim()]);
    if ((m = l.match(/letter-spacing:\s*([^;]+);/)) && lit(m[1].trim()) && m[1].trim() !== "normal") {
      out.letterSpacing.push([at, m[1].trim()]);
    }
    if ((m = l.match(/border-radius:\s*([^;]+);/))) {
      const v = m[1].trim();
      if (lit(v) && !SANCTIONED.circle.has(v) && !v.includes(" ") && v !== "0") out.radius.push([at, v]);
    }
    if ((m = l.match(/z-index:\s*([^;]+);/)) && lit(m[1].trim())) out.zIndex.push([at, m[1].trim()]);
    for (const c of l.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([\d.,\s]*\)|hsla?\([^)]*\)/g)) {
      const v = c[0];
      if (SANCTIONED.hueStrip.has(v.toLowerCase())) continue;
      if (isNeutralAlpha(v)) continue;
      out.color.push([at, v]);
    }
    // Transition durations only - animation timings are per-keyframe.
    if (/transition(-duration)?:/.test(l)) {
      for (const d of l.matchAll(/(?<![\w-])(\d+(?:\.\d+)?m?s)(?![\w-])/g)) {
        if (d[1] !== "0s" && d[1] !== "0ms") out.transition.push([at, d[1]]);
      }
    }
  });
}

let total = 0;
for (const [k, v] of Object.entries(out)) {
  total += k === "fauxWeight" ? 0 : v.length; // counted under fontWeight already
  console.log(String(v.length).padStart(5), k);
  if (LIST && v.length) for (const [at, val] of v) console.log("        ", at, val);
}
console.log("-".repeat(24));
console.log(String(total).padStart(5), "OUTLIERS");
if (out.fauxWeight.length) {
  console.log(`\n  ${out.fauxWeight.length} font-weight declarations request a face that is NOT loaded`);
  console.log("  (the browser silently substitutes another weight):");
  for (const [at, v] of out.fauxWeight) console.log("        ", at, v);
}
