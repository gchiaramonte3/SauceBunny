import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A control carries ONE name, not two that disagree.
 *
 * Most of this app's icon buttons have both a `title` and an `aria-label`, and
 * that is right: the tooltip can carry a key hint the accessible name should
 * not read aloud ("Close (Esc)" / "Close"). What is not right is the two using
 * DIFFERENT WORDS for the same thing. macOS Voice Control matches on the
 * accessible name, so a user who hovers, reads "Camera and mic settings" and
 * says it finds nothing — the name was "Camera and microphone settings". The
 * control answers to a phrase it never shows you.
 *
 * Six were like that. The worst pair also disagreed with the dialog it opens,
 * which DevicePanel names "Camera and microphone settings", so the button and
 * its own panel introduced themselves differently.
 *
 * The rule is containment, not equality, in either direction: a short name
 * inside a longer tooltip is fine, and so is the reverse. Parentheticals are
 * stripped first, because a key hint is exactly the thing a name should omit.
 *
 * NOT a WCAG 2.5.3 claim. That success criterion is about a control's VISIBLE
 * text label, and a tooltip is not visible until you hover. These are
 * icon-only buttons with no visible text, so 2.5.3 does not strictly apply.
 * The reason to fix them is the plainer one: two names for one control is a
 * defect whoever reads it next has to resolve.
 */

const ROOT = resolve(__dirname, "../..");

function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { out.push(...tsxUnder(full)); continue; }
    if (e.name.endsWith(".tsx") && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Lowercase, drop "(Esc)"-style hints and punctuation, collapse spaces. */
function norm(s: string): string {
  return s
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]/gi, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Pairs that differ only in how a NUMBER is written. Speech produces the word
 * form, so the accessible name is right to spell it out while the tooltip stays
 * compact next to its arrow-key hint.
 */
const NUMBER_WORDS: Array<[string, string]> = [
  ["1 frame", "one frame"],
];

const FILES = [...tsxUnder(join(ROOT, "src/components")), ...tsxUnder(join(ROOT, "src"))
  .filter((f) => !f.includes("/components/"))];

type Pair = { file: string; line: number; title: string; label: string };

const pairs: Pair[] = [];
for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/<[a-zA-Z][^>]*?>/gs)) {
    const el = m[0];
    const t = /title="([^"]+)"/.exec(el);
    const a = /aria-label="([^"]+)"/.exec(el);
    if (!t || !a) continue;
    pairs.push({
      file: file.replace(ROOT + "/", ""),
      line: text.slice(0, m.index).split("\n").length,
      title: t[1],
      label: a[1],
    });
  }
}

describe("one control, one name", () => {
  it("found controls carrying both a tooltip and an accessible name", () => {
    // The sweep is worthless if it matches nothing; this repo has had four
    // checks report success while scanning an empty set.
    expect(pairs.length, "no title+aria-label elements parsed").toBeGreaterThan(15);
  });

  it("never gives one control two different words for the same thing", () => {
    const clashes = pairs.filter((p) => {
      let a = norm(p.title);
      let b = norm(p.label);
      for (const [digit, word] of NUMBER_WORDS) {
        a = a.replace(digit, word);
        b = b.replace(digit, word);
      }
      // A tooltip longer than a short phrase is a DESCRIPTION, not a second
      // name, and holding it to containment is wrong. "Drag to resize ·
      // double-click to reset" on a handle named "Resize comment box" is the
      // tooltip doing its actual job — saying how to use the thing — and
      // "Drag to scrub, or focus and use the arrow keys" on the Playhead is
      // the same. Five words is where this app's tooltips stop naming and
      // start explaining; every real clash found was four words or fewer.
      if (a.split(" ").length > 5) return false;
      return !a.includes(b) && !b.includes(a);
    });
    expect(
      clashes.map((c) => `${c.file}:${c.line}\n      title="${c.title}"\n      aria-label="${c.label}"`),
      "Voice Control matches the accessible name; make one contain the other",
    ).toEqual([]);
  });
});
