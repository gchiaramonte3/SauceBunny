import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A tab strip never scrolls sideways.
 *
 * The AAF Audio transcript tabs did, one tab per person, and on a Mac set to
 * show scrollbars always (the default with a mouse attached, and what older
 * machines tend to run) the strip wore a permanent scrollbar under its tabs.
 * On a trackpad Mac the same strip looked fine and hid most of its tabs
 * behind a sideways swipe nobody goes looking for, which is why it survived.
 * A strip that can grow uses TabStrip (the tabs that fit, then "N more"); a
 * fixed strip either fits or collapses the way the drawer's does.
 *
 * Read from source because the failure is invisible in the harness: headless
 * Chromium uses overlay scrollbars, so no rendered test sees what the user saw.
 */

const ROOT = resolve(__dirname, "../..");
function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out);
    else if (e.name.endsWith(ext) && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Class names on every element that declares role="tablist". */
function tablistClasses(): string[] {
  const out = new Set<string>();
  for (const file of walk(resolve(ROOT, "src"), ".tsx")) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(/<[a-z]+\b[^<]*?role="tablist"[^<]*?>/g)) {
      const cls = /className="([^"]+)"/.exec(match[0])?.[1];
      cls?.split(/\s+/).forEach((name) => out.add(name));
    }
  }
  return [...out];
}

const css = walk(resolve(ROOT, "src/styles"), ".css").map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");

describe("tab strips", () => {
  const classes = tablistClasses();

  it("finds the tab strips it guards", () => {
    expect(classes.length).toBeGreaterThan(5);
    expect(classes).toContain("cp-tabstrip-list");
  });

  it.each(classes)("%s does not scroll sideways", (name) => {
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const targets = rule[1].split(",").map((selector) => selector.trim());
      if (!targets.some((selector) => new RegExp(`\\.${name}(?![\\w-])(?:\\[[^\\]]*\\]|:[\\w-]+)*$`).test(selector))) continue;
      if (/overflow(-x)?\s*:\s*(auto|scroll)\b/.test(rule[2])) offenders.push(rule[1].trim());
    }
    expect(offenders).toEqual([]);
  });
});
