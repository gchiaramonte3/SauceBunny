import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * "Settings → X" in user-facing copy has to name a tab that exists.
 *
 * This is instructional copy, and it is delivered at the worst possible
 * moment: YouTube demanding sign-in, an age-restricted video, a missing
 * Whisper model. Sending someone to a tab called something else, while they
 * are already blocked, is worse than saying nothing.
 *
 * Five were wrong when this was written, and each pointed somewhere real that
 * had simply been RENAMED:
 *   · "Settings → Source"       → the tab is "Web sources"  (twice: the
 *      sentence is duplicated verbatim in error.rs and error-format.ts)
 *   · "Settings → YouTube auth" → the tab is "Web sources"  (twice)
 *   · "Settings → Commands"     → the tab is "Shortcuts"
 *
 * Note the tab IDs are `youtube` and `commands` — so the copy was written
 * against the internal ids and drifted the day the labels changed. Nothing
 * connects the two, which is what this test is for.
 *
 * The labels are read from SettingsModal's TABS array, never retyped here: a
 * rename should make this fail, not silently agree with itself.
 */

const ROOT = resolve(__dirname, "../..");

const settingsSrc = readFileSync(join(ROOT, "src/components/SettingsModal.tsx"), "utf8");
const TAB_LABELS = [...settingsSrc.matchAll(/\{\s*id:\s*"[a-z-]+",\s*label:\s*"([^"]+)"\s*\}/g)]
  .map((m) => m[1]);

/** Sections inside a tab are legitimate targets too. */
const SECTION_LABELS = [...settingsSrc.matchAll(/<CollapsibleSection[^>]*label="([^"]+)"/g)]
  .map((m) => m[1]);

const TARGETS = new Set([...TAB_LABELS, ...SECTION_LABELS]);

function walk(dir: string, test: (f: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, test, out);
    else if (test(entry)) out.push(full);
  }
  return out;
}

const sources = [
  ...walk(join(ROOT, "src"), (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)),
  ...walk(join(ROOT, "src-tauri/src"), (f) => f.endsWith(".rs")),
];

/** Lines of copy (not comments) that send the user to a Settings location. */
function pointers() {
  const out: { file: string; line: number; target: string }[] = [];
  for (const f of sources) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      // must be inside a quoted string to be copy rather than prose
      if (!/["`'][^"`']*Settings\s*(?:→|▸|>)/.test(l)) return;
      // "System Settings → …" is macOS's own app, not ours.
      for (const m of l.matchAll(/(System )?Settings\s*(?:→|▸|>)\s*([A-Za-z][A-Za-z &]*)/g)) {
        if (m[1]) continue;
        out.push({ file: f.slice(ROOT.length + 1), line: i + 1, target: m[2].trim() });
      }
    });
  }
  return out;
}

describe("in-app pointers to Settings", () => {
  it("read the real tab labels", () => {
    // Retyping these would let the test agree with itself after a rename.
    expect(TAB_LABELS, "no TABS labels parsed from SettingsModal").toContain("Web sources");
    expect(TAB_LABELS.length).toBeGreaterThan(6);
    expect(SECTION_LABELS.length).toBeGreaterThan(3);
  });

  it("found the copy it checks", () => {
    expect(pointers().length, "no 'Settings → X' copy found — the matcher broke").toBeGreaterThan(8);
  });

  it("names a tab or section that exists", () => {
    const bad = pointers()
      // Copy runs on into a sentence ("Settings → Transcription first"), so a
      // pointer counts as good when it STARTS with a real target.
      .filter(({ target }) => ![...TARGETS].some((t) => target.startsWith(t)))
      .map(({ file, line, target }) => `${file}:${line} → "${target}"`);
    expect(bad, "copy sends the user to a Settings tab that does not exist").toEqual([]);
  });
});
