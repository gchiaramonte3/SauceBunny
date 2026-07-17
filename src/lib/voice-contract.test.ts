import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Voice-contract guard: no em dashes (U+2014) or en dashes (U+2013) in
 * user-facing strings. The UI copy voice is terse and plain; dashes in
 * comments are fine (they are not user-facing), so comments are stripped
 * before scanning. If this test fails, rewrite the sentence (a period or
 * a colon almost always works) or, for a legitimate non-copy use (regex
 * source, exported document content, a null-value placeholder glyph),
 * add a narrowly-scoped entry to ALLOWLIST below with a reason.
 */

const SRC_ROOT = path.resolve(__dirname, "..");
const DASH = /[–—]/;

/** Allowed dash uses. Each entry excuses lines in ONE file that match the
 *  pattern; anything else in that file is still flagged. Keep these narrow.
 *  (Regex literals need no entries: the scanner blanks them out.) */
const ALLOWLIST: { file: string; pattern: RegExp; reason: string }[] = [
  // Null-value placeholder glyph: a lone em dash standing in for "no data"
  // in stat rows, key chips, and inputs. A data glyph, not prose.
  { file: "src/components/LogsPanel.tsx", pattern: />—</, reason: "placeholder glyph for a missing timestamp" },
  { file: "src/components/SettingsModal.tsx", pattern: /"—"|>—</, reason: "placeholder glyph (empty size / unbound key)" },
  { file: "src/components/Sidebar.tsx", pattern: /"—"|placeholder="—"/, reason: "placeholder glyph for missing metadata" },
  { file: "src/components/transcript/HistoryPopover.tsx", pattern: /"—"/, reason: "placeholder glyph for a missing date" },
  { file: "src/lib/keybindings.ts", pattern: /"—"/, reason: "formatBindings placeholder for an unbound action" },
  // Prompt text sent to the local LLM. The model reads it, the user never
  // does; dash-separated clauses steer the model fine.
  { file: "src/components/AiSummary.tsx", pattern: /Structure lists as a (numbered|bulleted) list/, reason: "LLM prompt text" },
  { file: "src/lib/chapters.ts", pattern: /long — every timestamp|chapter lines — no intro|\(2–6 words\)/, reason: "LLM prompt text" },
  // Exported document content (Markdown/EDL written to disk), not UI copy.
  { file: "src/components/TranscriptViewer.tsx", pattern: /# Transcript — /, reason: "Markdown export header" },
  { file: "src/lib/markers.ts", pattern: /edlMarkerClean/, reason: "EDL marker export line" },
  { file: "src/lib/review.ts", pattern: /# Review — |mdInline/, reason: "Markdown export content" },
];

/** Collect every .ts/.tsx source file under src/, skipping test files
 *  (dashes in test fixtures/assertions are not user-facing copy). */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out // line comments, /* *\/ block comments, and regex literals
 * while preserving line structure (so reported line numbers stay true),
 * without touching comment-looking text inside string/template literals
 * (e.g. "https://"). Neither comments nor regex sources are user-facing
 * copy. Small state machine; template-literal `${}` interpolation is
 * treated as part of the template (a dash inside ${...} is still
 * flagged, which is the conservative direction for a guard).
 */
function stripNonCopy(source: string): string {
  let out = "";
  type Mode = "code" | "line" | "block" | "single" | "double" | "template" | "regex";
  let mode: Mode = "code";
  // Last significant (non-space) char emitted in code mode — decides whether
  // a `/` starts a regex literal or is a division sign. After an identifier,
  // number, or closing bracket it is division; anywhere else, a regex.
  let prev = "";
  let inRegexClass = false; // inside [...] a `/` does not close the regex
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; out += "  "; i++; continue; }
      if (c === "/" && next === "*") { mode = "block"; out += "  "; i++; continue; }
      // `/` starts a regex literal unless it is division (after an
      // identifier/number/closer) or JSX tag syntax (`</` close, `/>` self-close).
      if (c === "/" && !/[\w$)\]]/.test(prev) && prev !== "<" && next !== ">") {
        mode = "regex";
        inRegexClass = false;
        out += " ";
        continue;
      }
      if (c === "'") mode = "single";
      else if (c === '"') mode = "double";
      else if (c === "`") mode = "template";
      if (!/\s/.test(c)) prev = c;
      out += c;
    } else if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; } else out += " ";
    } else if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; out += "  "; i++; continue; }
      out += c === "\n" ? c : " ";
    } else if (mode === "regex") {
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === "[") inRegexClass = true;
      else if (c === "]") inRegexClass = false;
      else if (c === "/" && !inRegexClass) { mode = "code"; prev = "/"; out += " "; continue; }
      out += c === "\n" ? c : " ";
    } else {
      // Inside a string/template literal: honor escapes, watch for the closer.
      if (c === "\\") { out += c + (next ?? ""); i++; continue; }
      // Recovery: ' and " strings cannot contain a raw newline, so a newline
      // here means an apostrophe in JSX text opened a phantom string (the
      // scanner does not parse JSX). Bail back to code so the derailment
      // never extends past one line.
      if (c === "\n" && mode !== "template") { mode = "code"; out += c; continue; }
      if (
        (mode === "single" && c === "'") ||
        (mode === "double" && c === '"') ||
        (mode === "template" && c === "`")
      ) { mode = "code"; prev = c; }
      out += c;
    }
  }
  return out;
}

describe("voice contract", () => {
  it("no em/en dashes in user-facing strings (src/**/*.ts{,x})", () => {
    const violations: string[] = [];
    for (const file of collectSources(SRC_ROOT)) {
      const rel = path.relative(path.dirname(SRC_ROOT), file); // "src/…"
      const stripped = stripNonCopy(fs.readFileSync(file, "utf8"));
      stripped.split("\n").forEach((line, idx) => {
        if (!DASH.test(line)) return;
        const allowed = ALLOWLIST.some(
          (a) => a.file === rel && a.pattern.test(line),
        );
        if (!allowed) violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
      });
    }
    expect(
      violations,
      "Em/en dash in user-facing copy. Rewrite the sentence (voice contract: " +
        "terse and plain, no em dashes), or add a narrow ALLOWLIST entry in " +
        "voice-contract.test.ts if this is not UI copy:\n" +
        violations.join("\n"),
    ).toEqual([]);
  });
});
