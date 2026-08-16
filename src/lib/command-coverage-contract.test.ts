import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every rebindable action has a command-palette entry.
 *
 * `commands.ts` opens by saying the ⌘K palette "enumerates ALL of them with
 * fuzzy search", and App overlays each entry's hotkey with the user's live
 * binding so the palette never shows a stale literal. Both of those are only
 * true for actions that HAVE an entry.
 *
 * `view.reader` did not. Four of the five views were in the palette; typing
 * "transcript" into ⌘K offered no way to get to the Transcripts view, even
 * though ⌘5 and the nav rail both went there.
 *
 * The cause is worth keeping: `onNavigateView` was typed
 * `"home" | "library" | "clip" | "coreview"`, so the command could not be
 * written — its own callback would have rejected the argument. App's real
 * navigator always took the full `AppView`. A narrowed prop type quietly
 * removed a feature from one surface, and nothing failed.
 */

const ROOT = resolve(__dirname, "../..");
const keybindings = readFileSync(join(ROOT, "src/lib/keybindings.ts"), "utf8");
const commands = readFileSync(join(ROOT, "src/lib/commands.ts"), "utf8");

/** Ids in the rebindable registry (KEY_ACTIONS). */
const actionIds = [...keybindings.matchAll(/\{\s*id:\s*"([a-z.]+)"/g)].map((m) => m[1]);
/** Ids the palette offers. */
const commandIds = new Set([...commands.matchAll(/\{\s*id:\s*"([a-z.]+)"/g)].map((m) => m[1]));

describe("command palette coverage", () => {
  it("read both registries", () => {
    expect(actionIds.length, "no KEY_ACTIONS ids parsed").toBeGreaterThan(10);
    expect(commandIds.size, "no command ids parsed").toBeGreaterThan(20);
  });

  it("offers every rebindable action", () => {
    const missing = actionIds.filter((id) => !commandIds.has(id));
    expect(missing, "rebindable, but unreachable from ⌘K").toEqual([]);
  });

  it("can navigate to every view the app has", () => {
    // The narrowed callback type is what made the gap unfixable, so it is what
    // gets asserted: the union in commands.ts must carry every view id that
    // has a rebindable view.* action.
    const viewIds = actionIds
      .filter((id) => id.startsWith("view."))
      .map((id) => id.slice("view.".length))
      // view.logs / view.captions are toggles, not destinations.
      .filter((v) => !["logs", "captions"].includes(v));
    const nav = /onNavigateView:\s*\(view:\s*([^)]*)\)/.exec(commands)?.[1] ?? "";
    expect(viewIds.length).toBeGreaterThan(3);
    for (const v of viewIds) {
      expect(nav, `onNavigateView cannot be given "${v}"`).toContain(`"${v}"`);
    }
  });
});
