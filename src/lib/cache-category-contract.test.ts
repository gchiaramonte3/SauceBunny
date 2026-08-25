import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every cache category the Settings panel lists is one the backend can clear.
 *
 * The two lists are written in different languages in different files, and
 * nothing connected them: `CACHE_CATEGORIES` in SettingsModal.tsx renders the
 * rows, `clear_cache_category`'s match arm decides what a click does, and its
 * fallthrough is `Err("unknown cache category")`. Adding a row without adding
 * an arm produces a control that renders, counts bytes, and refuses on click —
 * the same shape as the list headers that looked sortable and were not.
 *
 * Caught when the "Received files" row was added for the co-review transfers
 * the size cap used to delete.
 */
const settings = readFileSync(join(__dirname, "../components/SettingsModal.tsx"), "utf8");
const systemRs = readFileSync(join(__dirname, "../../src-tauri/src/commands/system.rs"), "utf8");

/** The `id:` values inside the CACHE_CATEGORIES literal. */
function listedCategories(): string[] {
  const start = settings.indexOf("const CACHE_CATEGORIES = [");
  expect(start, "CACHE_CATEGORIES literal not found — this test would pass vacuously")
    .toBeGreaterThan(-1);
  const block = settings.slice(start, settings.indexOf("] as const;", start));
  return [...block.matchAll(/\bid:\s*"([a-z-]+)"/g)].map((m) => m[1]);
}

/** The category strings `clear_cache_category` actually matches on. */
function handledCategories(): string[] {
  const start = systemRs.indexOf("pub async fn clear_cache_category(");
  expect(start, "clear_cache_category not found").toBeGreaterThan(-1);
  const block = systemRs.slice(start, systemRs.indexOf("\n}\n", start));
  const arms = block.slice(block.indexOf("match category.as_str()"));
  // Arm heads only: `"a" | "b" => {`. Skips the `other =>` fallthrough.
  return [...arms.matchAll(/^\s*((?:"[a-z-]+"\s*\|?\s*)+)=>/gm)]
    .flatMap((m) => [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]));
}

describe("the cache categories the UI offers", () => {
  it("finds both lists, so the comparison is real", () => {
    expect(listedCategories().length, "no categories parsed from Settings").toBeGreaterThan(3);
    expect(handledCategories().length, "no match arms parsed from Rust").toBeGreaterThan(3);
  });

  it("are all clearable by the backend", () => {
    const handled = new Set(handledCategories());
    const orphans = listedCategories().filter((c) => !handled.has(c));
    expect(
      orphans,
      `Settings lists ${orphans.join(", ")} but clear_cache_category has no arm for them, ` +
        "so the Clear button answers \"unknown cache category\"",
    ).toEqual([]);
  });

  it("includes the co-review transfers, which the size cap must not evict", () => {
    // Exempt from automatic eviction (a received file does not regenerate),
    // which makes an explicit clear the ONLY way to remove it — so the row and
    // the arm both have to exist.
    expect(listedCategories()).toContain("transfers");
    expect(handledCategories()).toContain("transfers");
    expect(systemRs, "the cap must skip the transfers directory")
      .toMatch(/TRANSFERS_DIRNAME\)\s*\{\s*\n\s*continue;/);
  });
});
