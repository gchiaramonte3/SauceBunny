import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * NEW CSS classes carry the `cp-` prefix. A RATCHET, not a clean sweep.
 *
 * CLAUDE.md's operative sentence is "New code MUST use the `cp-` prefix" — not
 * "every class is prefixed". The same bullet says why the sweep is off the table:
 * the prefix is a carryover from the original ClipPull name, "kept intentionally
 * because renaming ~600 classes touches every file and adds no user-visible
 * value". So a guard that demanded every selector be prefixed would fail 184
 * times on day one and its only available fix would contradict the rule it came
 * from.
 *
 * What is left is the enforceable half, and it is the useful half: the 69 legacy
 * names below are pinned, and anything NEW must be prefixed. Same shape as
 * `dismiss-parity-contract` ("a RATCHET: the list may shrink, never grow") and
 * `storage-keys-contract`'s nine named exceptions.
 *
 * The list also may not rot. A pinned name that no longer appears in any
 * stylesheet is deleted from here by the second test — otherwise the allowlist
 * silently becomes permission for a FUTURE class to reuse a retired name.
 *
 * Comments are stripped before matching: prose in a stylesheet names classes,
 * and reading a description of a class as a class is a mistake this repo has
 * now made five separate ways.
 */

const STYLES = resolve(__dirname, "../styles");

/**
 * Legacy non-`cp-` class selectors, as of the day this guard was written.
 *
 * Mostly one shared layer that predates the namespace — the button set
 * (`btn`, `btn-primary`, `btn-ghost`, `btn-icon`), log rows, status pills — plus
 * a scattering of one-word state and slot names. May shrink. May not grow.
 */
const LEGACY = new Set([
  "actions", "active", "arrow", "badge", "bar", "beta", "body", "btn", "btn-ghost",
  "btn-icon", "btn-primary", "chev", "closed", "crumb", "cur", "desc", "detail", "dismiss",
  "dot", "dragging", "dur", "dur-pill", "err", "filler", "fmt", "grow", "hint", "icon",
  "k", "keys", "label", "lbl", "link", "live", "loading", "log-line", "mark", "meta",
  "msg", "n", "name", "off", "ok", "path", "progress", "progress-bar", "reveal", "scheme",
  "selected", "sep", "size", "status", "status-pill", "step", "strip", "sub", "tab-icon",
  "tag", "tc", "text", "thumb", "tick", "tick-label", "title", "ts", "v", "v-primary",
  "v-secondary", "ver",
]);

type Hit = { file: string; line: number; name: string };

/** Every class selector in every stylesheet, with comments removed first. */
function classSelectors(): Hit[] {
  const out: Hit[] = [];
  for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css"))) {
    const text = readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    text.split("\n").forEach((line, i) => {
      // `.name` not preceded by a word character, so `a.b` and decimals like
      // `.5rem` (digit-initial) are not selectors. Pseudo-classes and combinators
      // fall away because only the identifier is captured.
      for (const m of line.matchAll(/(?<![\w-])\.([A-Za-z][\w-]*)/g)) {
        out.push({ file: f, line: i + 1, name: m[1] });
      }
    });
  }
  return out;
}

const all = classSelectors();

describe("CSS class names", () => {
  it("are being read at all", () => {
    // Canary. Both assertions below are filters over this list, and an empty one
    // would pass forever while checking nothing.
    expect(all.length, "no class selectors found - the scan broke").toBeGreaterThan(500);
    expect(all.filter((h) => h.name.startsWith("cp-")).length,
      "no cp- classes found, so the prefix itself is not being seen").toBeGreaterThan(400);
  });

  it("use the cp- prefix unless they are a pinned legacy name", () => {
    const bad = all
      .filter((h) => !h.name.startsWith("cp-") && !LEGACY.has(h.name))
      .map((h) => `${h.file}:${h.line}  .${h.name}`);
    // Deduplicated so one new class in twelve places reads as one problem.
    expect([...new Set(bad)], "new CSS classes without the cp- prefix").toEqual([]);
  });

  it("has no pinned name that has already been retired", () => {
    // The ratchet only ratchets if the list shrinks when the code does. A stale
    // entry is standing permission for a future class to take a retired name.
    const live = new Set(all.map((h) => h.name));
    const dead = [...LEGACY].filter((n) => !live.has(n)).sort();
    expect(dead, "LEGACY names no longer in any stylesheet - delete them from the list")
      .toEqual([]);
  });
});
