import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every call String Outs makes into the app is timed in the Pipeline.
 *
 * String Outs hung with nothing to show for it: the backend journals its own
 * operations, but a call the page made and never got back, or a call that is
 * not one of the backend's operations at all (the undo log, an export, Ask),
 * left no trace. `pipelineInvoke` (lib/pipeline) times each one, says so while
 * it waits, and puts it in the export's table. That only holds if no String
 * Outs file reaches past it to Tauri's own `invoke`, which a new file would do
 * by habit: it is the import every other file in the app uses.
 */

const ROOT = resolve(__dirname, "../..");

/** The String Outs files: its components, its hooks and its libraries. */
function stringOutsFiles(): string[] {
  const pick = (dir: string, match: RegExp) => readdirSync(resolve(ROOT, dir))
    .filter((name) => match.test(name) && !/\.test\.tsx?$/.test(name)).map((name) => join(dir, name));
  return [
    ...pick("src/components", /^Edit\w*\.tsx$/),
    ...pick("src/hooks", /^use-edit[\w-]*\.ts$/),
    ...pick("src/lib", /^edit-[\w-]*\.ts$/),
    "src/lib/string-out-model.ts",
  ];
}

describe("String Outs calls go through the Pipeline", () => {
  const files = stringOutsFiles();

  it("finds the String Outs files", () => {
    // A scan that finds nothing certifies everything.
    expect(files.length, "no String Outs files found: the file patterns broke").toBeGreaterThan(60);
    const traced = files.filter((file) => /pipelineInvoke\("String Outs"\)/.test(readFileSync(resolve(ROOT, file), "utf8")));
    expect(traced.length, "no String Outs file times its calls: the import changed shape").toBeGreaterThan(10);
  });

  it("never imports Tauri's invoke directly", () => {
    const direct = files.filter((file) => /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["']/.test(readFileSync(resolve(ROOT, file), "utf8")));
    expect(direct, "These String Outs files call the app without the Pipeline seeing it. Use "
      + "`import { pipelineInvoke } from \"../lib/pipeline\"; const invoke = pipelineInvoke(\"String Outs\");` instead.").toEqual([]);
  });
});
