import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * `!important` stays at three sites, each with its reason written beside it.
 *
 * The rule in CLAUDE.md used to read "unless overriding a third-party style you
 * can't control", and not one of the three uses in the tree is that. Two force a
 * drag cursor to win over whatever is under the pointer; one overrides an inline
 * `style` React sets from component state. So the doc was corrected rather than
 * the code — an inline style outranks every class selector, which makes
 * `!important` the only lever CSS has, and calling that "third-party" would have
 * been a fiction invented to satisfy a rule.
 *
 * A ratchet, because the honest version of this rule is not mechanically
 * decidable. Whether a given `!important` was unavoidable or merely convenient is
 * a judgment a regex cannot make. What it CAN do is notice a fourth one appearing
 * and insist somebody argue for it — and require that each carries an explanation
 * a reader can find, since the failure mode here is not the declaration but the
 * silence around it.
 *
 * The count may shrink. It may not grow.
 */

const STYLES = resolve(__dirname, "../styles");

type Hit = { file: string; line: number; text: string; explained: boolean };

/**
 * Every `!important`, with whether it is explained.
 *
 * "Explained" means a comment on the same line or on one of the three lines
 * above — which is how the existing three are written, and close enough that a
 * reader hitting the declaration cannot miss the reason.
 */
function importants(): Hit[] {
  const out: Hit[] = [];
  for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css"))) {
    const lines = readFileSync(join(STYLES, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("!important")) return;
      const sameLine = /\/\*|\*\//.test(line);
      const above = lines.slice(Math.max(0, i - 3), i).join("\n");
      const nearby = /\/\*|\*\/|^\s*\*/m.test(above);
      out.push({ file: f, line: i + 1, text: line.trim(), explained: sameLine || nearby });
    });
  }
  return out;
}

const hits = importants();

/** The three sanctioned uses, as of the day the rule was corrected. */
const ALLOWED = 3;

describe("!important", () => {
  it("is being counted in real stylesheets", () => {
    // Canary. A ratchet pinned at 3 that silently found 0 would pass forever and
    // would also mean the scan had stopped working.
    expect(readdirSync(STYLES).filter((n) => n.endsWith(".css")).length).toBeGreaterThan(10);
    expect(hits.length, "no !important found at all - the scan broke").toBeGreaterThan(0);
  });

  it("has not grown past the three sanctioned uses", () => {
    const listed = hits.map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 76)}`);
    expect(
      hits.length,
      `!important count changed. If you removed one, lower ALLOWED. If you added ` +
        `one, argue for it in CLAUDE.md first.\n  ${listed.join("\n  ")}`,
    ).toBeLessThanOrEqual(ALLOWED);
  });

  it("carries its reason at every site", () => {
    // The declaration is not the problem; an unexplained one is. Six months on,
    // nobody can tell an unavoidable !important from a shortcut without the note.
    const bare = hits
      .filter((h) => !h.explained)
      .map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 76)}`);
    expect(bare, "!important with no comment on or above the line").toEqual([]);
  });

  it("keeps ALLOWED honest, so a removal is not silently absorbed", () => {
    // Without this the ratchet only ever loosens: delete two uses and the limit of
    // 3 still permits three, so the pair can quietly come back later.
    expect(hits.length, `ALLOWED is ${ALLOWED} but the tree has ${hits.length} - update ALLOWED`)
      .toBe(ALLOWED);
  });
});
