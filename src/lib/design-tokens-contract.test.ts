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
 * What this does NOT enforce is the off-scale values, and that is deliberate.
 * 67 declarations use 2px, 5px, 7px and 10px, which is too many to be
 * mistakes: it says the scale (4 / 6 / 8 / 12 / 16) does not match what the UI
 * actually needs. Whether to add steps or to move those to the nearest rung is
 * a design decision with visible consequences, so it stays a decision rather
 * than becoming a rule enforced by a robot.
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
