import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every component must be reachable from somewhere.
 *
 * The bug this pins is one that shipped: OpenSourceCredits was written,
 * styled, and tested, and then never imported by anything. It passed tsc,
 * passed the suite, and was simply absent from the running app - the user
 * found it by going to look for it and not finding it. Nothing in the build
 * notices a component nobody mounts, because an unused module is not an
 * error in any of the tools; it just quietly is not there.
 *
 * The check is deliberately crude - "is this file imported by any other
 * non-test source file" - because the failure mode is crude. It cannot tell
 * whether a mounted component is reachable through the UI, and it does not
 * try to. It catches the orphan.
 *
 * There is no allowlist. A component nothing imports is either wired up or
 * deleted; carrying it in a list of blessed exceptions is how the drawer of
 * dead components starts.
 */

const SRC = path.resolve(__dirname, "..");
const COMPONENTS = path.join(SRC, "components");

const isSource = (f: string) => /\.tsx?$/.test(f) && !f.includes(".test.");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (isSource(entry.name)) out.push(full);
  }
  return out;
}

describe("no component is written and then left unmounted", () => {
  it("every component in src/components is imported by something", () => {
    const components = fs.readdirSync(COMPONENTS)
      .filter((f) => f.endsWith(".tsx") && isSource(f))
      .map((f) => f.slice(0, -4));
    // Sanity: if this ever reads zero files the assertion below is vacuous.
    expect(components.length).toBeGreaterThan(20);

    const sources = walk(SRC).map((p) => ({
      base: path.basename(p),
      text: fs.readFileSync(p, "utf8"),
    }));

    const orphans = components.filter((name) => {
      // Any import specifier ending in this module name, whatever the
      // relative prefix ("./Foo", "../components/Foo").
      const spec = new RegExp(`from\\s+"[^"]*/${name}"`);
      return !sources.some((s) => s.base !== `${name}.tsx` && spec.test(s.text));
    });

    expect(
      orphans,
      `these components are imported by nothing, so they are not in the app: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});
