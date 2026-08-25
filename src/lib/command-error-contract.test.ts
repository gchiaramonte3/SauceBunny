import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `#[tauri::command]` returns `Result<T, AppError>`.
 *
 * This is the invariant that actually matters: the invoke boundary is what the
 * renderer sees, and `formatError` in lib/error-format.ts is written against a
 * typed `AppError`. A command that rejects with a bare string still *renders*
 * — `From<String>` maps it to `Invalid` — but the frontend then cannot branch
 * on the kind, which is the whole point of having the enum.
 *
 * Written because the claim was being TRUSTED rather than checked, and had
 * drifted. CLAUDE.md's refactor item #4 said "zero `Result<T, String>`
 * signatures left" and error.rs said "every command and helper"; four private
 * helpers still returned String. Nothing in the gate noticed, because the one
 * error-related contract (`error-format.test.ts`) reads the generated TS
 * binding and never looks at a Rust signature.
 *
 * Private helpers are deliberately NOT covered. They are converted at the `?`
 * and their errors reach the boundary typed; forbidding them would be a style
 * rule, and this file is for contracts that have a failure mode.
 */

const COMMANDS_DIR = join(__dirname, "../../src-tauri/src/commands");

/** Every .rs file under commands/, read once. */
function commandFiles(): { name: string; text: string }[] {
  return readdirSync(COMMANDS_DIR)
    .filter((f) => f.endsWith(".rs"))
    .map((name) => ({ name, text: readFileSync(join(COMMANDS_DIR, name), "utf8") }));
}

/**
 * The return type of each `#[tauri::command]`, found by walking forward from
 * the attribute to the first `->` before the opening brace.
 *
 * A regex over the whole file would match helpers too, which is exactly the
 * distinction this test exists to draw.
 */
function commandReturnTypes(text: string): { fn: string; ret: string }[] {
  const out: { fn: string; ret: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("#[tauri::command")) continue;
    // Signature can span lines; stop at the body.
    let sig = "";
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
      sig += lines[j];
      if (lines[j].includes("{")) break;
      sig += " ";
    }
    const nameMatch = /fn\s+([A-Za-z0-9_]+)/.exec(sig);
    const retMatch = /->\s*([^{]+)/.exec(sig);
    if (nameMatch) {
      out.push({ fn: nameMatch[1], ret: (retMatch?.[1] ?? "()").trim() });
    }
  }
  return out;
}

describe("the invoke boundary is fully typed", () => {
  const files = commandFiles();

  it("finds the commands at all, so the assertions below cannot pass vacuously", () => {
    const total = files.reduce((n, f) => n + commandReturnTypes(f.text).length, 0);
    expect(files.length, "no .rs files found under commands/").toBeGreaterThan(5);
    expect(total, "parsed zero #[tauri::command] fns — the parser broke").toBeGreaterThan(100);
  });

  it("has no #[tauri::command] returning Result<_, String>", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const { fn, ret } of commandReturnTypes(f.text)) {
        if (/Result\s*<.*,\s*String\s*>/.test(ret)) bad.push(`${f.name} :: ${fn} -> ${ret}`);
      }
    }
    expect(
      bad,
      "a command rejects with a bare string, so the frontend cannot branch on the error kind:\n" +
        bad.join("\n"),
    ).toEqual([]);
  });

  it("every fallible command returns AppError specifically", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const { fn, ret } of commandReturnTypes(f.text)) {
        if (!ret.startsWith("Result")) continue; // infallible commands are fine
        if (!ret.includes("AppError")) bad.push(`${f.name} :: ${fn} -> ${ret}`);
      }
    }
    expect(bad, "a fallible command's error type is not AppError:\n" + bad.join("\n")).toEqual([]);
  });

  it("CLAUDE.md's Rust rule prescribes AppError, not the retired String pattern", () => {
    // The rule contributors are pointed at first drifted behind the roadmap
    // section of the same file for ~100 revisions, telling new code to write
    // the exact pattern error.rs forbids.
    const claude = readFileSync(join(__dirname, "../../CLAUDE.md"), "utf8");
    const style = claude.slice(claude.indexOf("### Rust"));
    const section = style.slice(0, style.indexOf("### ".padEnd(4) + "Swift"));
    expect(section, "the Rust code-style section must name AppError").toContain("AppError");
    expect(
      section,
      "the Rust code-style section still prescribes `Result<T, String>` from commands",
    ).not.toMatch(/return `Result<T, String>` from commands/);
  });
});
