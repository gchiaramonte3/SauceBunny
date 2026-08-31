import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Your device is off" is drawn in ONE colour.
 *
 * Reported from a live session: the self tile's mute button was solid
 * --danger red, the roster badge 20px below it in the same tile was --fg-2
 * grey, and the same mute in the room bar was --warning amber. Three colours,
 * one fact, one screen.
 *
 * The colour is --danger-text rather than the solid --danger because every one
 * of these is a GLYPH, and two of them sit on a translucent plate over live
 * video. Composited over a bright frame that plate lands near #4F4F50, where
 * solid --danger measures 1.85:1 and misses 1.4.11's 3:1 for a meaningful
 * graphic; --danger-text is 3.61:1 there and 8.05:1 against the dark bar.
 *
 * This checks the DECLARATION, not the rendered pixel, because the rendered
 * one is checked by e2e/contrast.spec.ts and cannot tell you that two agreeing
 * colours were arrived at separately and may drift apart again.
 */

// Comments are STRIPPED first. Without this the scan reads its own prose: the
// note on .cp-room-bar-btn.off names .cp-person-ctl.off, so the lookup for
// that selector matched the comment and returned the room bar's colour. Both
// rules agreed at the time, so it passed while measuring the wrong thing.
const css = readFileSync(join(__dirname, "../styles/room.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Selectors that all assert the same thing: this device is off. */
const OFF_STATE_SELECTORS = [
  ".cp-person-ctl.off",   // the self tile's camera/mic switches
  ".cp-room-bar-btn.off", // the same mute, in the session control bar
  ".cp-person-muted",     // the roster badge that repeats it
];

/** Read the `color:` a selector's own rule sets. */
function colorOf(selector: string): string | null {
  // Escape for a literal match, then take the rule body up to the first `}`.
  const head = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(^|[,}\\s])${head}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m");
  const found = css.match(rule);
  if (!found) return null;
  const color = found[2].match(/(?:^|;)\s*color:\s*([^;]+)/);
  return color ? color[1].trim() : null;
}

describe("device-off state colour", () => {
  it("every off-state selector in the stylesheet is present", () => {
    // The canary. Rename a class and the agreement check below would pass on
    // an empty set, which is how a scanning guard quietly stops guarding.
    for (const sel of OFF_STATE_SELECTORS) {
      expect(colorOf(sel), `${sel} has no color: declaration in room.css`).toBeTruthy();
    }
    expect(OFF_STATE_SELECTORS.length).toBeGreaterThan(2);
  });

  it("they all name the same token", () => {
    const colors = OFF_STATE_SELECTORS.map((sel) => [sel, colorOf(sel)] as const);
    const distinct = new Set(colors.map(([, c]) => c));
    expect(
      distinct.size,
      `one state, one colour. Found: ${colors.map(([s, c]) => `${s} -> ${c}`).join(", ")}`,
    ).toBe(1);
  });

  it("that token is the one legible on a dark plate", () => {
    // Solid --danger is 1.85:1 over the tile plate above bright video. If a
    // later edit reaches for it because it is the more obvious name, this
    // fails rather than shipping an indicator nobody can see.
    for (const sel of OFF_STATE_SELECTORS) {
      expect(colorOf(sel), `${sel} draws a glyph, so it needs --danger-text`).toBe(
        "var(--danger-text)",
      );
    }
  });
});
