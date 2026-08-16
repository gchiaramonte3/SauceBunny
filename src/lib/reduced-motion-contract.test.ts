import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every keyframe animation obeys `prefers-reduced-motion`, checked statically.
 *
 * There is already an e2e test for this, and it is the reason this file exists
 * rather than a replacement for it. The e2e probe walks the rendered page and
 * skipped any element whose `offsetParent` was null — which is true of EVERY
 * `position: fixed` element, so it silently excluded the popovers, scrims,
 * banners and modal backdrops where entrance animations mostly live. It
 * reported the policy as perfect for as long as it existed. Fourteen unguarded
 * animations were behind that blind spot, including the settings backdrop
 * fading in behind a dialog that was correctly holding still, and an INFINITE
 * pulse on the live-session dot.
 *
 * Reading the stylesheets has no blind spot: a rule counts whether or not
 * anything happens to render it in a test.
 *
 * Two guard shapes are both legitimate, and the difference matters:
 *  · `animation: none` — correct for an entrance with no fill, which already
 *    ends on the resting style it animates toward.
 *  · a calmer REPLACEMENT — required when the original uses `forwards`, where
 *    the final frame IS the resting style. `.cp-reaction-float` rises and fades
 *    to `opacity: 0` and stays there; `animation: none` would strand every
 *    floating emoji visible on the video for ever. It swaps in an opacity-only
 *    fade of the same duration instead.
 *
 * TRANSITIONS are covered too, and by construction rather than by listing:
 * their guards are `transition-duration: 0s`, never `transform: none`, because
 * several of the transforms involved are load-bearing (centring, and the
 * sidebar's reveal). See e2e/reduced-motion.spec.ts for the geometry check that
 * pins that distinction.
 */

const STYLES = resolve(__dirname, "../styles");
const FILES = readdirSync(STYLES).filter((f) => f.endsWith(".css"));

/** `[selectorList, body]` for each rule, keeping FULL multi-line selectors. */
function rules(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const sel = text.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, " ").split(/\s+/).join(" ").trim();
    let k = open + 1;
    let depth = 1;
    while (k < text.length && depth > 0) {
      if (text[k] === "{") depth++;
      else if (text[k] === "}") depth--;
      k++;
    }
    out.push([sel, text.slice(open + 1, k - 1)]);
    i = k;
  }
  return out;
}

/**
 * Animations whose guard is in JavaScript rather than CSS, so no stylesheet
 * can show it. Each entry names the file and line that does the gating.
 */
const GUARDED_IN_JS: Record<string, string> = {
  ".cp-lib-hero-bg.cp-hero-cycle.kb-in":
    "HeroMontage.tsx matchMedia gate — renders nothing under reduce",
  ".cp-lib-hero-bg.cp-hero-cycle.kb-out":
    "HeroMontage.tsx matchMedia gate — renders nothing under reduce",
};

type Use = { file: string; selector: string; value: string };

const declared: Use[] = [];
const guarded = new Map<string, "none" | "replaced">();

for (const file of FILES) {
  const text = readFileSync(join(STYLES, file), "utf8");
  for (const [sel, body] of rules(text)) {
    if (sel.startsWith("@media") && sel.includes("prefers-reduced-motion: reduce")) {
      for (const [inner, innerBody] of rules(body)) {
        if (inner.startsWith("@")) continue;
        if (!/animation(-\w+)?\s*:/.test(innerBody)) continue;
        const kind = /animation:\s*none/.test(innerBody) ? "none" : "replaced";
        for (const one of inner.split(",")) guarded.set(one.trim(), kind);
      }
      continue;
    }
    if (sel.startsWith("@")) continue;
    const m = /\banimation:\s*([^;]+);/.exec(body);
    if (!m || m[1].includes("none")) continue;
    for (const one of sel.split(",")) {
      declared.push({ file, selector: one.trim(), value: m[1].trim() });
    }
  }
}

describe("prefers-reduced-motion", () => {
  it("found the stylesheets and the animations in them", () => {
    // The failure this whole file is a reaction to was a check that measured
    // nothing and reported success, so: prove there is something to measure.
    expect(FILES.length).toBeGreaterThan(15);
    expect(declared.length).toBeGreaterThan(40);
    expect(guarded.size).toBeGreaterThan(30);
  });

  it("guards every keyframe animation", () => {
    const unguarded = declared.filter(
      (d) =>
        !guarded.has(d.selector) &&
        !guarded.has(d.selector.split(":")[0].trim()) &&
        !(d.selector in GUARDED_IN_JS),
    );
    expect(
      unguarded.map((d) => `${d.file}  ${d.selector}  ${d.value}`),
      "unguarded animation — add it to a @media (prefers-reduced-motion: reduce) block",
    ).toEqual([]);
  });

  it("replaces rather than removes an animation that fills forwards", () => {
    // The trap: with `forwards` the LAST frame is the resting style, so
    // `animation: none` snaps the element back to its first frame and leaves it
    // there. For a reaction that fades itself out, that is a permanent pile-up
    // of emoji on the video.
    for (const d of declared) {
      if (!/\bforwards\b/.test(d.value)) continue;
      if (d.selector in GUARDED_IN_JS) continue;
      const kind = guarded.get(d.selector) ?? guarded.get(d.selector.split(":")[0].trim());
      expect(kind, `${d.selector} fills forwards, so it needs a calmer replacement, not \`none\``)
        .toBe("replaced");
    }
  });

  it("never neutralises a transform that is doing the centring", () => {
    // Overriding `transform` under reduce is sometimes exactly right: the
    // equaliser bars freeze at `scaleY(0.7)`, a deliberate resting height for a
    // stopped animation, and `.cp-sbtn-layer` is `position: absolute; inset: 0`
    // where none IS the natural place. So the rule is not "never touch
    // transform".
    //
    // The one shape that is always a bug is neutralising a `-50%` translate.
    // That is the centring idiom — the element is offset by half its own width
    // or height to sit on a point — so replacing it with anything else moves it
    // visibly off target. It is why the 41 transition suppressions in this
    // codebase zero the DURATION instead: `.cp-playhead::before`,
    // `.cp-ai-chip::after` and the follow pill all centre this way.
    const centred = new Set<string>();
    for (const file of FILES) {
      for (const [sel, body] of rules(readFileSync(join(STYLES, file), "utf8"))) {
        if (sel.startsWith("@")) continue;
        const m = /transform:\s*([^;]+);/.exec(body);
        if (m && m[1].includes("-50%")) for (const one of sel.split(",")) centred.add(one.trim());
      }
    }
    expect(centred.size, "no centring transforms found — the probe is measuring nothing")
      .toBeGreaterThan(3);

    const offenders: string[] = [];
    for (const file of FILES) {
      for (const [sel, body] of rules(readFileSync(join(STYLES, file), "utf8"))) {
        if (!sel.startsWith("@media") || !sel.includes("prefers-reduced-motion: reduce")) continue;
        for (const [inner, innerBody] of rules(body)) {
          const m = /transform:\s*([^;]+);/.exec(innerBody);
          if (!m) continue;
          for (const one of inner.split(",")) {
            const s = one.trim();
            if (centred.has(s) && !m[1].includes("-50%")) offenders.push(`${file}  ${s} → ${m[1]}`);
          }
        }
      }
    }
    expect(offenders, "this element is centred by its transform; zero the transition duration instead")
      .toEqual([]);
  });
});
