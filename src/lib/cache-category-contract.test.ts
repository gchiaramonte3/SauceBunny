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
const libRsRaw = readFileSync(join(__dirname, "../../src-tauri/src/lib.rs"), "utf8");
/**
 * Rust with comments removed.
 *
 * The negative assertions below MUST run against this. Written against the raw
 * file, the "is the legacy name back?" check failed immediately - on the
 * comment that explains the bug, which naturally quotes the very string it is
 * warning about. A guard that a correct fix cannot pass is worse than no
 * guard: the obvious way out is to delete the explanation.
 */
const libRs = libRsRaw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

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

  it("is skipped by clear-on-quit too, which is the THIRD walker", () => {
    // Three places walk the media cache and all three must know about this
    // exemption: the size cap, the Settings clear buttons, and the shutdown
    // handler. The third was found the hard way.
    //
    // Clear-on-quit was joining the LEGACY directory name ("saucebunny-media",
    // renamed to "media" by migrate_cache_layout), so on every upgraded
    // install it silently did nothing. The obvious one-word fix would have
    // made it delete `transfers/` on every quit - taking a setting that did
    // nothing and turning it into one that destroys the only copy of every
    // file a peer ever sent, which is very much worse than the bug it fixes.
    // Comments stripped: the doc comment on that helper naturally names
    // TRANSFERS_DIRNAME while explaining the exemption, so the raw file
    // matched even with the filter deleted. Verified by removing the filter -
    // this assertion passed and only the Rust unit test caught it. It is the
    // second time in this session a scan matched its own explanation.
    const systemCode = systemRs
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    // Scoped to THAT FUNCTION'S BODY, not a character window after its name.
    // A window of any size reaches into the next function, which mentions
    // TRANSFERS_DIRNAME for the sibling exemption - so deleting the filter
    // still matched, and again only the Rust unit test caught it. Same
    // boundary-crossing mistake a non-greedy regex made in the screening
    // contract earlier today.
    const fnStart = systemCode.indexOf("fn quit_clearable_media_entries");
    expect(fnStart, "quit_clearable_media_entries not found").toBeGreaterThan(-1);
    const body = systemCode.slice(fnStart, systemCode.indexOf("\n}", fnStart));
    expect(body, "the quit sweep must exempt transfers")
      .toContain("TRANSFERS_DIRNAME");
    expect(libRs, "clear-on-quit must call the exempting sweep")
      .toMatch(/quit_clearable_media_entries/);
    // The legacy name must not reappear as a literal anywhere it is joined
    // onto a path: that is the exact shape of the bug.
    expect(libRs, "clear-on-quit is back on the legacy directory name")
      .not.toMatch(/join\("saucebunny-media"\)/);
    expect(libRs, "clear-on-quit must not remove the whole media tree")
      .not.toMatch(/remove_dir_all\(&media\)/);
  });
});
