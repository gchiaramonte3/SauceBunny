import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Two tables the app keeps in two places on purpose, pinned so they agree.
 *
 * `SettingsModal.tsx` carries the comment "MUST stay in sync with FONT_STACK in
 * CaptionOverlay.tsx (same keys + stacks)". A sentence like that is a rule with
 * nothing enforcing it, and this codebase has already been bitten by exactly
 * that shape — four copies of a talk-time formatter that had drifted twice, and
 * a CONTEXTUAL_SHORTCUTS list carrying its own "keep this in sync" note.
 *
 * Neither table has drifted. They are pinned rather than merged because the
 * repo already answers this question that way: `rung-ladder-contract` keeps the
 * TS and Rust rung tables in step with a test instead of sharing code across a
 * boundary. Merging these would mean either a renderer importing from a
 * settings dialog, or a new module for eight font stacks.
 *
 * What drift would cost:
 *  · fonts — the Settings preview shows one typeface and the caption overlay
 *    renders another, for the same choice.
 *  · formats — the sidebar offers an export preset the settings pane does not
 *    know, or vice versa.
 */

const ROOT = resolve(__dirname, "../..");
const settings = readFileSync(join(ROOT, "src/components/SettingsModal.tsx"), "utf8");
const overlay = readFileSync(join(ROOT, "src/components/CaptionOverlay.tsx"), "utf8");
const sidebar = readFileSync(join(ROOT, "src/components/Sidebar.tsx"), "utf8");

/** `{ key: "value" }` pairs out of a named object literal. */
function objectTable(src: string, name: string): Record<string, string> | null {
  const m = new RegExp(`${name}[^=]*=\\s*\\{(.*?)\\n\\};`, "s").exec(src);
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/(\w+):\s*"([^"]*)"/g)].map((x) => [x[1], x[2]]));
}

/** `{ id: "x", label: "y" }` entries out of a named array literal. */
function idLabelTable(src: string, name: string): Array<[string, string]> | null {
  const m = new RegExp(`${name}[^=]*=\\s*\\[(.*?)\\];`, "s").exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]);
}

describe("caption fonts", () => {
  const inSettings = objectTable(settings, "CAP_FONTS");
  const inOverlay = objectTable(overlay, "FONT_STACK");

  it("found both tables", () => {
    // A rename that defeats the matcher must fail here rather than quietly
    // stop comparing anything.
    expect(inSettings, "CAP_FONTS not found in SettingsModal").toBeTruthy();
    expect(inOverlay, "FONT_STACK not found in CaptionOverlay").toBeTruthy();
    expect(Object.keys(inSettings!).length).toBeGreaterThan(4);
  });

  it("offers exactly the fonts the overlay can render", () => {
    expect(Object.keys(inSettings!).sort()).toEqual(Object.keys(inOverlay!).sort());
  });

  it("uses the same stack for each, so the preview matches the picture", () => {
    expect(inSettings).toEqual(inOverlay);
  });

  it("labels every font it offers", () => {
    const labels = objectTable(settings, "CAP_FONT_LABELS");
    expect(labels, "CAP_FONT_LABELS not found").toBeTruthy();
    expect(Object.keys(labels!).sort()).toEqual(Object.keys(inSettings!).sort());
  });
});

describe("export formats", () => {
  const inSidebar = idLabelTable(sidebar, "FORMATS");
  const inSettings = idLabelTable(settings, "FORMATS");

  it("found both tables", () => {
    expect(inSidebar, "FORMATS not found in Sidebar").toBeTruthy();
    expect(inSettings, "FORMATS not found in SettingsModal").toBeTruthy();
    expect(inSidebar!.length).toBeGreaterThan(2);
  });

  it("offers the same presets in the same order", () => {
    // Order matters: these render as a row of chips, and two orders would read
    // as two different features.
    expect(inSidebar).toEqual(inSettings);
  });
});
