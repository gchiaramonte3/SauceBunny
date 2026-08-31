import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing in this app may declare an element HTML5-draggable.
 *
 * On macOS, `draggable` is not a local UI affordance. Starting such a drag
 * opens a real NSDragging session with the window server, and Tauri's webview
 * drag-drop listener - the one DropTarget subscribes to in order to catch FILE
 * imports from Finder - observes that session entering the webview. It cannot
 * tell it from a Finder drag, because at that layer it is the same thing.
 *
 * So an in-app drag made the app announce, full screen, "drop a video, audio
 * or SRT file to import". Reported as: grabbing the Size column header to move
 * it asks me to import a video. Nothing was wrong with DropTarget. The header
 * was telling the OS a drag had begun.
 *
 * The app's own drags are therefore pointer-based - the column reorder and the
 * web-collection drop both are - which is also the better gesture: a real
 * movement threshold, an insertion indicator we can style, and a drop resolved
 * by our own hit test rather than the OS's.
 *
 * `draggable={false}` is the OPPOSITE and is expected. It suppresses the
 * browser's built-in image drag, which is the same defect arriving by default
 * on every <img>. It is allowed everywhere and is not what this scans for.
 */

const SRC = "src";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    // readdirSync, not globSync: CI pins Node 20 and globSync landed in 22.
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no HTML5 native drag", () => {
  const files = walk(SRC).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  it("scanned a real population", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds the draggable={false} uses it must NOT flag", () => {
    // The canary. If the matcher below stopped recognising the attribute at
    // all, the rule would pass over nothing and report a clean bill for ever.
    // These are the legitimate uses, so seeing them proves the scan has eyes.
    const negatives = files.filter((f) =>
      /draggable=\{false\}/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(negatives.length).toBeGreaterThan(5);
  });

  it("no element is declared draggable", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      src.split("\n").forEach((line, i) => {
        // JSX `draggable`, `draggable={true}`, and the object-literal
        // `draggable: true` that a spread props bag uses.
        if (/draggable=\{true\}|draggable\s*:\s*true|<[^>]*\sdraggable(\s|>|\/)/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
