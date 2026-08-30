import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `role="menu"` IS A PROMISE, AND ELEVEN OF THEM WERE NOT KEPT.
 *
 * A screen reader that meets role="menu" switches its user into menu
 * navigation and tells them to use the arrow keys. Eleven menus in this app
 * were built as role="menu" wrapping role="menuitem" buttons, and exactly two
 * handled an arrow key. That is worse than not using the role: plain buttons
 * in a plain container would have been more accessible, because nothing would
 * have told the user to press keys the app ignores.
 *
 * `useMenuKeys` implements the ARIA Authoring Practices menu button pattern
 * once - focus in on open, arrows with wrap, Home/End, type-ahead, Escape,
 * Tab to leave, roving tabindex, focus restored on close. This pins that every
 * menu uses it.
 *
 * WHY A SOURCE CONTRACT RATHER THAN MORE E2E. The rendered guard
 * (`e2e/popover-focus.spec.ts`) exercises three named triggers, and most of
 * these menus are unreachable from its boot state - a row menu needs a seeded
 * library, the reaction popover needs a live session. That is a POPULATION
 * blind spot, and the tool for a population is a scan over the source, not a
 * browser that cannot get to eight of the eleven.
 */

const COMPONENTS = join(__dirname, "..", "components");

/** Every component file that declares a menu, with its text. */
function menuFiles(): { name: string; src: string; menus: number }[] {
  const out: { name: string; src: string; menus: number }[] = [];
  // readdirSync, not globSync: CI pins Node 20 and globSync is Node 22.
  for (const name of readdirSync(COMPONENTS)) {
    if (!name.endsWith(".tsx") || name.includes(".test.")) continue;
    const src = readFileSync(join(COMPONENTS, name), "utf8");
    // Comments stripped, or a file merely DISCUSSING role="menu" counts as
    // declaring one - and the doc comment on the hook itself quotes it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    const menus = (code.match(/role="menu"/g) ?? []).length;
    if (menus > 0) out.push({ name, src: code, menus });
  }
  return out;
}

describe("every ARIA menu implements the menu keyboard model", () => {
  const files = menuFiles();

  it("finds the menus at all", () => {
    // CANARY. `expect(missing).toEqual([])` passes just as happily over an
    // empty list, and a renamed attribute or a changed quoting style would
    // empty it silently.
    expect(files.length, "no components declare role=\"menu\"").toBeGreaterThanOrEqual(10);
    const total = files.reduce((n, f) => n + f.menus, 0);
    expect(total, "fewer menus than expected - did the scan stop finding them?")
      .toBeGreaterThanOrEqual(11);
  });

  it("each one calls useMenuKeys", () => {
    const missing = files.filter((f) => !/useMenuKeys\s*\(/.test(f.src)).map((f) => f.name);
    expect(missing, "declares role=\"menu\" without the keyboard model").toEqual([]);
  });

  it("a file with two menus wires both", () => {
    // TranscriptViewer has Tools AND Download. One hook call would leave the
    // other menu promising arrows and ignoring them, and the check above
    // cannot see the difference.
    const short = files
      .filter((f) => (f.src.match(/useMenuKeys\s*\(/g) ?? []).length < f.menus)
      .map((f) => `${f.name}: ${f.menus} menus, ${(f.src.match(/useMenuKeys\s*\(/g) ?? []).length} wired`);
    expect(short, "more menus than useMenuKeys calls").toEqual([]);
  });

  it("the model itself still answers the keys it promises", () => {
    // The hook is the single point of failure for all eleven now, so its
    // surface is worth pinning here rather than only in its own unit test.
    const hook = readFileSync(join(__dirname, "..", "hooks", "use-menu-keys.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"]) {
      expect(hook, `useMenuKeys no longer handles ${k}`).toContain(`"${k}"`);
    }
    expect(hook, "roving tabindex is gone, so every item is a tab stop again")
      .toMatch(/tabIndex = -1/);
  });
});
