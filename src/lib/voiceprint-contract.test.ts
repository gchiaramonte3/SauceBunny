import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Voiceprints are biometric data (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md,
 * phase 4): 256 numbers that identify a person by how they sound. They live in
 * the app's support folder and nowhere else. Not in ~/Documents, which iCloud
 * syncs; not on the co-review wire; not in the context layer that answers
 * assistants; not in any command's answer to the renderer. Only the LABELS
 * they settle (owner, other) travel, through the ownership cache.
 *
 * A source scan, because the failure is a single careless line: a cache moved
 * next to the document, a field added to a payload. Nothing at runtime would
 * notice either.
 */
const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const strip = (text: string) => text.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
const rustFiles = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? rustFiles(join(dir, entry.name)) : entry.name.endsWith(".rs") ? [join(dir, entry.name)] : []);

describe("voiceprints stay in the app's support folder", () => {
  const voices = strip(read("src-tauri/src/commands/aaf/voices.rs"));

  it("are written under app_data_dir, never under Documents", () => {
    const writes = voices.match(/write_bytes_impl\([^;]*/g) ?? [];
    expect(writes.length, "the voice check no longer saves anything: re-derive this contract").toBeGreaterThan(0);
    // Every write lands in the voiceprints folder, from the app's support folder.
    for (const write of writes) expect(write).toMatch(/file\(&app_data, /);
    expect(voices).toMatch(/let app_data = app\.path\(\)\.app_data_dir\(\)/);
    expect(voices).toMatch(/fn dir\(app_data: &Path\) -> PathBuf \{ app_data\.join\("voiceprints"\) \}/);
    expect(voices).not.toMatch(/document_dir/);
  });

  it("never reach the context layer that answers assistants", () => {
    const context = rustFiles("src-tauri/src/context");
    expect(context.length, "scanned no context files").toBeGreaterThan(3);
    for (const file of context) expect(strip(read(file)), file).not.toMatch(/voices::|Voiceprints|voiceprint/i);
    expect(strip(read("src-tauri/src/mcp.rs"))).not.toMatch(/voices::|Voiceprints/);
  });

  it("never ride the co-review wire", () => {
    const wire = rustFiles("src-tauri/src/commands").filter((file) => /session|peer_stream|review/.test(file));
    expect(wire.length, "scanned no session or review files").toBeGreaterThan(2);
    for (const file of wire) expect(strip(read(file)), file).not.toMatch(/voices::|Voiceprints|voiceprint/i);
  });

  it("are never handed to the renderer: no command answers with them, and the label cache holds none", () => {
    const commands = strip(read("src-tauri/src/commands/aaf.rs"));
    expect(commands).toContain("pub async fn aaf_check_voices");
    expect(commands).not.toMatch(/->\s*Result<[^>]*Voiceprints/);
    const ownership = strip(read("src-tauri/src/commands/aaf/ownership.rs"));
    const answer = ownership.slice(ownership.indexOf("pub struct AafOwnership {"), ownership.indexOf("}", ownership.indexOf("pub struct AafOwnership {")));
    expect(answer.length, "could not find the answer struct").toBeGreaterThan(100);
    expect(answer).not.toMatch(/Vec<f32>|Voice\b|early|centroid/);
  });
});
