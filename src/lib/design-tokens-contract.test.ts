import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const STYLES = resolve(__dirname, "../styles");

/**
 * `--font-mono` has to come with tabular figures.
 *
 * This app deliberately ships ONE typeface. tokens.css says so, and says how
 * the numeric contexts still work: "Nunito Sans supports
 * `font-variant-numeric: tabular-nums` so timecode columns still line up
 * perfectly." So `--font-mono` is not a different family at all - it is a
 * marker meaning "digits matter here", and it only does anything if the rule
 * also asks for tabular figures.
 *
 * Twenty-nine of the thirty-eight rules using it did not. The one that gave
 * the game away was `.cp-input-tc`, the Mark In / Mark Out timecode field,
 * whose comment read "tabular-nums + mono so HH:MM:SS:FF fits without
 * clipping" above a rule that set the family and never set the figures. The
 * intent was written down, agreed with, and not implemented - which is what a
 * convention with no enforcement decays into.
 *
 * The cost was visible rather than theoretical: proportional digits change
 * width as they change value, so a running timecode, a download percentage
 * and a cache size all shimmied while they counted, and a column of queue
 * numbers did not line up.
 */

function cssFiles(): Array<[name: string, text: string]> {
  return readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => [f, readFileSync(join(STYLES, f), "utf8")]);
}

/** Top-level rule bodies, brace-matched. A regex spanning `{...}` reports
 *  neighbouring rules as one, which is how earlier audits got false hits. */
function bodies(css: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(css.slice(start, i));
        start = -1;
      }
    }
  }
  return out;
}

const USES_MONO = /var\(\s*--font-mono\s*\)/;
const HAS_TABULAR = /font-variant-numeric\s*:\s*[^;]*tabular-nums/;

describe("--font-mono always brings tabular figures", () => {
  it("has no rule that asks for the token and skips the figures", () => {
    const offenders: string[] = [];
    for (const [name, css] of cssFiles()) {
      for (const body of bodies(css)) {
        // One level of nesting: @media / @supports wrap real rules.
        const inner = /^[\s]*[.#a-zA-Z@:[]/.test(body) && body.includes("{") ? bodies(body) : [body];
        for (const b of inner.length ? inner : [body]) {
          if (USES_MONO.test(b) && !HAS_TABULAR.test(b)) {
            offenders.push(`${name}: ${b.trim().split("\n")[0]}`);
          }
        }
      }
    }
    expect(
      offenders,
      "Add `font-variant-numeric: tabular-nums;` next to it. The token means " +
        "'digits matter here', and on a single-typeface app it does nothing else.",
    ).toEqual([]);
  });

  it("really is reading the stylesheets", () => {
    // A scanner that finds no rules reports perfect compliance.
    const all = cssFiles();
    expect(all.length).toBeGreaterThan(5);
    const usingMono = all.filter(([, css]) => USES_MONO.test(css));
    expect(usingMono.length).toBeGreaterThan(3);
  });

  it("keeps the three font tokens on one family, which is the whole premise", () => {
    // Not a ban on changing it: if --font-mono ever becomes a real monospace
    // stack, this is the test that makes you say so out loud, because doing it
    // quietly restyles every one of those sites.
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    const stack = (n: string) => new RegExp(`--font-${n}:\\s*([^;]+);`).exec(tokens)?.[1].trim();
    expect(stack("sans")).toBeTruthy();
    expect(stack("ui")).toBe(stack("sans"));
    expect(stack("mono")).toBe(stack("sans"));
  });
});

/**
 * Every token in tokens.css is referenced by something.
 *
 * Seventeen of eighty-seven were not: the leftovers of three naming
 * generations (--novella-*, --bg-N / --stroke-N, --color-*) layered over each
 * other, where each migration was started and none was finished. That is the
 * state a design system decays into without a check - not wrong values, just
 * more names than decisions, so the next person picks whichever one they
 * happen to see first and the drift compounds.
 *
 * Adding a token before its first use fails this. That is intended: use it,
 * then it exists.
 */
describe("no unreferenced design tokens", () => {
  const SRC = resolve(__dirname, "..");

  function corpus(): string {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        // tokens.css INCLUDED: --dur-slow and --ease-out are referenced only
        // from inside it, and excluding the file would report them as dead and
        // invite a deletion that breaks the transition they build. A
        // definition reads `--x:`, never `var(--x)`, so nothing here can
        // satisfy itself.
        else if (/\.(css|ts|tsx|html)$/.test(e.name)) out.push(readFileSync(full, "utf8"));
      }
    };
    walk(SRC);
    return out.join("\n");
  }

  it("has no token that nothing uses", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    const all = [...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    const text = corpus();
    const dead = [...new Set(all)].filter(
      (t) => !new RegExp(`var\\(\\s*${t}\\s*[,)]`).test(text) && !new RegExp(`["'\`]${t}["'\`]`).test(text),
    );
    expect(
      dead,
      "Unreferenced tokens. Delete them, or use them - a name with no use is " +
        "one more thing the next person has to choose between.",
    ).toEqual([]);
  });

  it("really is reading tokens.css", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    expect([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].length).toBeGreaterThan(40);
  });
});

/**
 * The radius scale is used, not re-typed.
 *
 * 306 of the 406 `border-radius` declarations were literals, and 186 of those
 * spelled out a value the scale already names: 8px sixty-nine times, 6px
 * sixty-six, 4px forty-one. A scale followed a quarter of the time is not a
 * scale, it is a suggestion, and the drift it produces is invisible until two
 * things that should match do not.
 *
 * Those 186 are now `var(--r-*)`. Safe to do mechanically because the tokens
 * are defined once, at `:root`, and never redefined in a narrower scope -
 * checked before substituting, since a scoped override would have made this a
 * behaviour change rather than a rename.
 *
 * The off-scale values used to be left alone here, with a note saying the 67
 * declarations of 2px, 5px, 7px and 10px were too many to be mistakes and that
 * choosing between adding steps and rounding them was a design decision rather
 * than a rule for a robot. That decision has now been made, by looking at what
 * each of them actually was (r162):
 *
 *   2px  x16  had no name at all      -> --r-2xs, a new step
 *   10px x14  model card, notification popover, floating player panel, toast,
 *             welcome row - ONE family, the radius of a surface that floats,
 *             deliberately between a control's 8 and a container's 12
 *                                     -> --r-card, a new step
 *   5px  x12  small tiles, chips, thumbs, close buttons -> --r-sm (6)
 *   7px  x10  inputs, rows, cells                       -> --r-md (8)
 *   3px, 9px, 11px, 14px, 1px, 1.5px, 3.5px             -> nearest rung
 *
 * The two clusters were decisions with nowhere to live, and got names. The
 * rest were nobody choosing 5 over 6 - a 1px difference on a small control is
 * what eyeballing produces, not an intention, and rounding it is the drift
 * being corrected rather than a redesign.
 *
 * Still not enforced: `50%`, `0`, and per-corner shorthands like
 * `0 0 6px 6px`. Those are shape, not size.
 */
describe("radius scale", () => {
  const RADIUS = /border-radius\s*:\s*([^;{}]+);/g;

  function tokenValues(): Map<string, string> {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    return new Map([...tokens.matchAll(/(--r-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[2].trim(), m[1]]));
  }

  it("defines every radius token once, at :root", () => {
    // The premise of the substitution. A scoped redefinition would mean a
    // literal and its token are no longer interchangeable.
    const defs = cssFiles().flatMap(([name, css]) =>
      [...css.matchAll(/(--r-[a-z0-9-]+)\s*:\s*[^;]+;/g)].map(() => name),
    );
    expect(new Set(defs)).toEqual(new Set(["tokens.css"]));
  });

  it("never writes a literal that a token already names", () => {
    const byValue = tokenValues();
    const offenders: string[] = [];
    for (const [name, css] of cssFiles()) {
      for (const m of css.matchAll(RADIUS)) {
        const val = m[1].trim();
        if (val.includes("var(")) continue;
        const token = byValue.get(val);
        if (token) offenders.push(`${name}: border-radius: ${val} -> use var(${token})`);
      }
    }
    expect(offenders, "The scale already has a name for this value.").toEqual([]);
  });

  it("leaves 50% alone, which is the circle idiom and not a scale value", () => {
    // --r-pill (999px) and 50% are not interchangeable on a non-square box,
    // so this is a real distinction rather than an unconverted literal.
    const all = cssFiles().flatMap(([, css]) => [...css.matchAll(RADIUS)].map((m) => m[1].trim()));
    expect(all.filter((v) => v === "50%").length).toBeGreaterThan(10);
  });

  it("really is finding declarations", () => {
    const all = cssFiles().flatMap(([, css]) => [...css.matchAll(RADIUS)]);
    expect(all.length).toBeGreaterThan(200);
  });
});

/**
 * A weight the app has not loaded is a weight the browser invents.
 *
 * Nunito Sans ships as separate WOFF2 faces and src/main.tsx imports five of
 * them: 300, 400, 400-italic, 600, 700, 800. Ask for anything else and CSS
 * font matching silently substitutes the nearest available face - no error,
 * no warning, just type that is not the weight the stylesheet asked for.
 *
 * `font-weight: 500` appeared fifteen times across seven files and every one
 * of them rendered as 400. The intent had been written down repeatedly and
 * had never once reached the screen, which is the exact failure mode a
 * convention with no enforcement has: it looks decided and it is not.
 *
 * This is the guard for that, and it is about the IMPORTS as much as the
 * CSS - if someone adds the 500 face, --weight-medium becomes legitimate and
 * this test should be updated to allow it, deliberately, rather than the CSS
 * quietly starting to work.
 */
describe("font-weight only names a face that is actually loaded", () => {
  const MAIN = resolve(__dirname, "../main.tsx");

  /** The weights src/main.tsx imports, read rather than assumed. */
  function loadedWeights(): Set<string> {
    const main = readFileSync(MAIN, "utf8");
    return new Set(
      [...main.matchAll(/@fontsource\/nunito-sans\/(\d+)(?:-italic)?\.css/g)].map((m) => m[1]),
    );
  }

  it("imports the faces this app claims to use", () => {
    // Guards the guard: a refactor that moved the imports would otherwise
    // leave this suite passing against an empty set.
    expect([...loadedWeights()].sort()).toEqual(["300", "400", "600", "700", "800"]);
  });

  it("defines a weight token for every loaded face worth naming, and no others", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    const declared = [...tokens.matchAll(/--weight-[a-z]+\s*:\s*(\d+)\s*;/g)].map((m) => m[1]);
    const loaded = loadedWeights();
    for (const w of declared) {
      expect(loaded.has(w), `--weight token for ${w}, which no @fontsource import loads`).toBe(true);
    }
    // 300 is loaded but has no token: nothing in the app uses a light weight,
    // and a token with no use fails the unreferenced check above.
    expect(declared.sort()).toEqual(["400", "600", "700", "800"]);
  });

  it("has no stylesheet asking for a face that was never loaded", () => {
    const loaded = loadedWeights();
    const offenders: string[] = [];
    for (const [name, css] of cssFiles()) {
      if (name === "tokens.css") continue;
      css.split("\n").forEach((line, i) => {
        const m = line.replace(/\/\*.*?\*\//g, "").match(/font-weight\s*:\s*(\d+)\s*;/);
        if (m && !loaded.has(m[1])) {
          offenders.push(`${name}:${i + 1} font-weight: ${m[1]} - no such face is imported, so it renders as another weight`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("writes weights through the token, not as a number", () => {
    const offenders: string[] = [];
    for (const [name, css] of cssFiles()) {
      if (name === "tokens.css") continue;
      css.split("\n").forEach((line, i) => {
        if (/font-weight\s*:\s*\d/.test(line.replace(/\/\*.*?\*\//g, ""))) {
          offenders.push(`${name}:${i + 1}`);
        }
      });
    }
    expect(offenders, "Use var(--weight-*) so the loaded-face check can see it.").toEqual([]);
  });
});

/**
 * The app-level stacking order has names, and the ceiling stopped climbing.
 *
 * Before this there were 27 distinct z-index values from -1 to 10002, and
 * the comments on the highest ones told the whole story: "one above the
 * notification popover (9999)", "above the thumbnail modal's tier". Nobody
 * designed that. Each author picked one higher than whatever they were
 * losing to, and the number that wins today loses next month.
 *
 * The cost was not hypothetical. The transcript row menu rendered at 401
 * inside a tree that stacks past 10000, so its Rename dialog opened
 * underneath the app - present in the DOM, invisible on screen, and
 * indistinguishable from a button that does nothing.
 *
 * The line this draws is between APP layers and LOCAL ones. A value that
 * only has to beat its own siblings (a fill under a pin, a ruler over a
 * track) is local, stays a small integer, and is none of this test's
 * business - tokenizing those would destroy the ordering they exist for.
 * A value that has to beat another COMPONENT is an app layer, and those
 * are the ones that spiral, so those need a name.
 */
describe("z-index: app layers are named, local stacking is left alone", () => {
  /** Above this, a value is competing with other components, not siblings. */
  const LOCAL_CEILING = 99;

  it("defines the ladder once, at :root, in ascending order", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    const rungs = [...tokens.matchAll(/(--z-[a-z]+)\s*:\s*(\d+)\s*;/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(rungs.length).toBeGreaterThanOrEqual(5);
    const values = rungs.map(([, v]) => v);
    expect(values, "the ladder should read in order, so the file is the diagram").toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size, "two rungs at one value is one rung").toBe(values.length);
  });

  it("has no stylesheet inventing its own app-level number", () => {
    const offenders: string[] = [];
    for (const [name, css] of cssFiles()) {
      if (name === "tokens.css") continue;
      css.split("\n").forEach((line, i) => {
        const m = line.replace(/\/\*.*?\*\//g, "").match(/z-index\s*:\s*(-?\d+)\s*;/);
        if (m && Number(m[1]) > LOCAL_CEILING) {
          offenders.push(`${name}:${i + 1} z-index: ${m[1]} - above ${LOCAL_CEILING} is an app layer; use a --z-* rung`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("still allows the local small integers, which are not drift", () => {
    // If this ever hits zero, someone has swept the local values into the
    // ladder and thrown away the sibling ordering they encode.
    const locals = cssFiles()
      .filter(([n]) => n !== "tokens.css")
      .flatMap(([, css]) => [...css.matchAll(/z-index\s*:\s*(-?\d+)\s*;/g)])
      .filter((m) => Number(m[1]) <= LOCAL_CEILING);
    expect(locals.length).toBeGreaterThan(30);
  });
});

/**
 * The radius scale is now COMPLETE, so an off-scale literal is drift.
 *
 * This could not be asserted until the two missing steps existed: before
 * r162 a 10px corner had no token to point at, so failing it would have
 * demanded a visible change with nowhere good to go. Now every real value
 * has a name, and writing a number means reaching past all of them.
 */
describe("radius scale is complete", () => {
  /** Shape, not size - these are exempt on purpose. */
  const SHAPE = /^(50%|0|inherit)$/;

  it("has no off-scale literal left", () => {
    const offenders: string[] = [];
    for (const [name, css] of cssFiles()) {
      if (name === "tokens.css") continue;
      css.split("\n").forEach((line, i) => {
        const m = line.replace(/\/\*.*?\*\//g, "").match(/border-radius\s*:\s*([^;{}]+);/);
        if (!m) return;
        const v = m[1].trim();
        if (v.includes("var(") || SHAPE.test(v) || v.includes(" ")) return;
        offenders.push(`${name}:${i + 1} border-radius: ${v} - the scale has a rung for this`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the per-corner shorthands, which are shape", () => {
    const shorthand = cssFiles().flatMap(([, css]) =>
      [...css.matchAll(/border-radius\s*:\s*([^;{}]+);/g)].map((m) => m[1].trim()),
    ).filter((v) => v.includes(" ") && !v.includes("var("));
    expect(shorthand.length).toBeGreaterThan(2);
  });
});

/**
 * Sizes come from the scale.
 *
 * 553 font-size declarations used 29 distinct values. Half of the drift was
 * pairs half a pixel apart - 10/10.5, 11/11.5, 12/12.5, 13/13.5 - and the
 * giveaway was finding both members of a pair on the same kind of label in
 * the same file, with no comment anywhere explaining a difference. Nobody
 * chose 11.5 over 11; they typed a number that looked about right.
 *
 * Exempt, and each for a reason rather than by convenience:
 *   `font-size: 0`  the hide-the-text idiom, not a size
 *   em units        the reader deliberately scales with a user-set size
 *   var(--cap-size) caption size is set at runtime
 */
describe("font-size comes from the type scale", () => {
  it("has no stylesheet writing a pixel size", () => {
    const offenders: string[] = [];
    for (const [name, css] of cssFiles()) {
      if (name === "tokens.css") continue;
      css.split("\n").forEach((line, i) => {
        const m = line.replace(/\/\*.*?\*\//g, "").match(/font-size\s*:\s*([^;{}]+);/);
        if (!m) return;
        const v = m[1].trim();
        if (v.includes("var(") || v === "0" || v === "inherit" || /em$/.test(v)) return;
        offenders.push(`${name}:${i + 1} font-size: ${v} - use a --text-* rung`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the em-relative reader sizes, which scale with the user's choice", () => {
    const ems = cssFiles().flatMap(([, css]) =>
      [...css.matchAll(/font-size\s*:\s*([\d.]+em)\s*;/g)],
    );
    expect(ems.length).toBeGreaterThan(2);
  });

  it("defines the scale once, at :root, in ascending order", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    const rungs = [...tokens.matchAll(/--text-[a-z0-9]+\s*:\s*([\d.]+)px\s*;/g)].map((m) => Number(m[1]));
    expect(rungs.length).toBeGreaterThanOrEqual(8);
    expect(rungs, "the file should read as the scale it is").toEqual([...rungs].sort((a, b) => a - b));
  });
});
