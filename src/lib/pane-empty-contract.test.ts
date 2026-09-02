import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The four drawer tabs share one empty state - the words as well as the box.
 *
 * base.css's `.cp-pane-empty` was documented as THE empty state for Queue,
 * Review, AI Summary and Transcript, "one geometry so the four faces agree",
 * and all four mounted it. The typography did not agree: AI's title was
 * xl/bold/fg-1, Queue's and Transcript's were lg/semibold/fg-2, Review had no
 * title class and inherited lg/fg-3 from its wrapper. Switching tabs on an
 * empty drawer changed the title's size (14 to 13px), weight (700 to 600)
 * and colour, and nothing could see it because each pane's classes were
 * valid on their own.
 *
 * So: the title is `.cp-pane-empty-title`, the body is `.cp-pane-empty-body`,
 * both live beside `.cp-pane-empty` in base.css, and no pane may define its
 * own `-empty-title` / `-empty-body` / `-empty-sub`.
 */

const STYLES = join(__dirname, "../styles");
const COMPONENTS = join(__dirname, "../components");

/** Empty-state classes that are NOT a drawer pane. Shrink-only; each must
 *  still exist, or the entry is a door left open for nothing. */
const ALLOWED = [
  // The sidebar's metadata heading while no source is loaded: an <h2> in a
  // form column, not a centred pane, and it shares nothing with the four.
  "sidebar.css  .cp-meta-empty-title",
];

describe("pane-empty-contract", () => {
  const base = readFileSync(join(STYLES, "base.css"), "utf8");
  const sheets = readdirSync(STYLES)
    .filter((f) => f.endsWith(".css") && f !== "base.css")
    .map((f) => [f, readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")] as const);
  const tsx = readdirSync(COMPONENTS)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => [f, readFileSync(join(COMPONENTS, f), "utf8")] as const);

  it("the shared title and body exist, and enough panes use them", () => {
    expect(base).toMatch(/^\.cp-pane-empty-title \{/m);
    expect(base).toMatch(/^\.cp-pane-empty-body \{/m);
    const users = tsx.filter(([, t]) => /cp-pane-empty-title/.test(t)).map(([f]) => f);
    expect(users.length, `fewer than four panes use the shared title (${users.join(", ")}) - the scan or the app broke`).toBeGreaterThanOrEqual(4);
  });

  it("no pane defines its own empty-state typography", () => {
    const own: string[] = [];
    for (const [file, text] of sheets) {
      for (const m of text.matchAll(/^([^\n{]*-empty-(title|body|sub)\b[^\n{]*)\{/gm)) own.push(`${file}  ${m[1].trim()}`);
      for (const m of text.matchAll(/^(\.cp-[a-z-]*-empty \.sub)\s*\{/gm)) own.push(`${file}  ${m[1]}`);
    }
    for (const entry of ALLOWED) {
      expect(own, `allowlisted ${entry} no longer exists - delete the entry`).toContain(entry);
    }
    expect(own.filter((o) => !ALLOWED.includes(o)), "a per-pane empty-state class. Use cp-pane-empty-title / cp-pane-empty-body from base.css:").toEqual([]);
    const jsx: string[] = [];
    for (const [file, text] of tsx) {
      for (const m of text.matchAll(/className="[^"]*\bcp-(?!pane-|meta-)[a-z-]*-empty-(title|body|sub)\b[^"]*"/g)) {
        jsx.push(`${file}  ${m[0]}`);
      }
    }
    expect(jsx, "a pane's own empty-state class in JSX:").toEqual([]);
  });
});
