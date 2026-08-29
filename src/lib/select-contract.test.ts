import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Select contract.
 *
 * Written after finding the rule already broken almost everywhere: of the
 * sixteen `<select>` elements in the app, FOURTEEN were drawing macOS's own
 * control inside a hand-rolled dark UI. Nine carried `cp-select`, which
 * matched no rule in any stylesheet — a styling hook that styled nothing.
 * Five more had colours but no `appearance: none`, which looks like a fix
 * and is not: the platform still paints the frame and the double arrow, and
 * only the background changes.
 *
 * Three rules, and the third is the subtle one:
 *
 *  1. every `<select>` carries `cp-select`, so one primitive governs;
 *  2. `.cp-select` declares `appearance: none` (and the -webkit- prefix
 *     WKWebView still needs) — without it nothing else in the rule is
 *     visible, because the native control paints over all of it;
 *  3. no rule on a select's class uses the `background` SHORTHAND. The
 *     chevron is a background-image, so a later shorthand resets it and
 *     leaves a select with no arrow at all — strictly worse than the
 *     native control it replaced. Two rules did exactly this and were
 *     split (.cp-colobby-input, shared with the lobby's text inputs, and
 *     .cp-review-export-select, which shared a rule with a timecode
 *     input). `background-color` is what these rules always meant.
 */

const COMPONENTS = path.resolve(__dirname, "../components");
const STYLES = path.resolve(__dirname, "../styles");

function walk(dir: string, hit: (p: string) => void): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hit);
    else hit(p);
  }
}

function sourceFiles(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  walk(COMPONENTS, (p) => {
    if (!p.endsWith(".tsx") || p.includes(".test.")) return;
    // Comments mention `<select>` in prose (four do, describing controls that
    // were REMOVED). Scanning them reports offenders that are not elements.
    const text = decomment(fs.readFileSync(p, "utf8")).replace(/(^|[^:])\/\/.*$/gm, "$1");
    out.push({ file: path.relative(COMPONENTS, p), text });
  });
  return out;
}

function styleSheets(): { file: string; text: string }[] {
  return fs
    .readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(STYLES, f), "utf8") }));
}

/** Every `<select …>` opening tag, with its attributes flattened to one line. */
function selectTags(text: string): string[] {
  const out: string[] = [];
  // JSX attributes wrap freely, so take everything to the tag's closing ">".
  const re = /<select\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const rest = text.slice(m.index);
    const end = rest.indexOf(">");
    if (end > 0) out.push(rest.slice(0, end).replace(/\s+/g, " "));
  }
  return out;
}

/** Strip comments so a rule quoted in prose is not read as a declaration. */
const decomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("select contract", () => {
  it("every <select> carries cp-select", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const { file, text } of sourceFiles()) {
      for (const tag of selectTags(text)) {
        scanned++;
        if (!/\bcp-select\b/.test(tag)) offenders.push(`${file}: ${tag.slice(0, 90)}`);
      }
    }
    // Canary: a broken file filter would otherwise report a clean bill of
    // health over zero selects.
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it(".cp-select kills the native control", () => {
    const buttons = styleSheets().find((s) => s.file === "buttons.css");
    expect(buttons).toBeDefined();
    const rule = decomment(buttons!.text).match(/(?:^|\n)\.cp-select\s*\{([\s\S]*?)\}/);
    expect(rule, ".cp-select must be defined in buttons.css").not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/(?:^|[\s;])appearance:\s*none/);
    expect(body).toMatch(/-webkit-appearance:\s*none/);
  });

  it("no rule on a select's class uses the background shorthand", () => {
    // The classes that actually land on a <select> in the app.
    const classes = new Set<string>();
    for (const { text } of sourceFiles()) {
      for (const tag of selectTags(text)) {
        const cls = tag.match(/className="([^"]+)"/);
        if (cls) for (const c of cls[1].split(/\s+/)) if (c.startsWith("cp-")) classes.add(c);
      }
    }
    expect(classes.size).toBeGreaterThan(5); // canary

    const offenders: string[] = [];
    for (const { file, text } of styleSheets()) {
      for (const chunk of decomment(text).split("}")) {
        const brace = chunk.lastIndexOf("{");
        if (brace < 0) continue;
        const selector = chunk.slice(0, brace).split("{").pop()?.trim() ?? "";
        const decls = chunk.slice(brace + 1);
        const touches = [...classes].some((c) => new RegExp(`\\.${c}\\b`).test(selector));
        if (!touches) continue;
        // `background:` exactly — not background-color/-image/-position/-repeat.
        if (/(?:^|[\s;])background\s*:/.test(decls)) {
          offenders.push(`${file}  ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
