import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A token that tokens.css defines gets NO hex fallback.
 *
 * `token-usage-contract` already exempts `var(--token, #fallback)` from the
 * no-hardcoded-hex rule, and its reasoning is sound: the literal only applies
 * when the token is undefined, which cannot happen while tokens.css loads. It
 * also names the cost — "a hazard if the token is ever retuned".
 *
 * The palette was retuned, and the hazard arrived. Thirty-four fallbacks were
 * left holding the OLD value: `var(--bg-1, #161616)` when `--bg-1` is `#0e0e10`,
 * `var(--color-accent-green, #7bdcb5)` when the token is `#6cff8d`. Only six of
 * forty agreed. Nothing rendered wrong — the fallbacks are unreachable, which is
 * exactly why nobody noticed — but every one of them told a reader a colour the
 * app does not use, in a stylesheet whose whole job is to be the source of truth.
 *
 * Removed rather than re-synced. Re-syncing forty copies rebuilds the same
 * hazard for the next retune; deleting them ends it. They are provably dead:
 * `css-var-contract` asserts every `var()` resolves, so a fallback for a defined
 * token is code that cannot run.
 *
 * A fallback for a token tokens.css does NOT define is still legitimate and is
 * left alone — `--label-color` and friends are set inline from JSX per element,
 * and their fallback is the only value a stylesheet can offer.
 */

const STYLES = resolve(__dirname, "../styles");
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8");

/** Custom properties tokens.css actually defines. */
const defined = new Set([...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

type Hit = { file: string; line: number; token: string; fallback: string; want: string };

function redundantFallbacks(): Hit[] {
  const out: Hit[] = [];
  for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css") && n !== "tokens.css")) {
    const text = readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,\s*(#[0-9A-Fa-f]{3,8})\s*\)/g)) {
        const token = m[1];
        if (!defined.has(token)) continue;   // set inline from JSX: fallback is all there is
        const want = /(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})/.exec(
          TOKENS.slice(TOKENS.indexOf(`${token}:`)),
        )?.[2] ?? "?";
        out.push({ file: f, line: i + 1, token, fallback: m[2], want });
      }
    });
  }
  return out;
}

describe("hex fallbacks on defined tokens", () => {
  it("is reading real stylesheets and a real token file", () => {
    // Canary. An empty token set would make every hit exempt and the assertion
    // below vacuous — the failure mode this repo keeps shipping.
    expect(defined.size, "tokens.css parsed to nothing").toBeGreaterThan(40);
    expect(readdirSync(STYLES).filter((n) => n.endsWith(".css")).length,
      "no stylesheets found").toBeGreaterThan(10);
    expect(defined.has("--bg-1"), "a known token is missing - the parse is wrong").toBe(true);
  });

  it("do not exist, because the token is the value", () => {
    const hits = redundantFallbacks().map(
      (h) => `${h.file}:${h.line}  var(${h.token}, ${h.fallback})  token is ${h.want}`,
    );
    expect(hits, "a defined token carries a duplicate hex fallback").toEqual([]);
  });
});
