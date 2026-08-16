import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A hand-rolled click-outside dismisser is a RATCHET: the list may shrink,
 * never grow.
 *
 * Click-outside and Escape always arrive together in intent and keep arriving
 * apart in code. `use-dismiss.ts` exists because of the first case:
 * HistoryPopover and InsightsPopover were written as siblings with
 * byte-identical outside-click handlers, and only one handled Escape — the
 * transcript history ignored the key entirely. Making the hook did not stop it
 * recurring: the AI Summary's Export menu, a `role="menu"` with four items,
 * had the click-outside half and no Escape path at all. Every other menu in
 * the app closed on Escape; that one did not.
 *
 * WHY A RATCHET AND NOT THE OBVIOUS TEST. The obvious test is "a file with an
 * outside-click handler must also mention Escape". I wrote that first, then
 * reverted the Export-menu fix to check it — and it PASSED. `AiSummary.tsx`
 * says "Escape" elsewhere, in an unrelated slash-command handler, so a
 * file-level search finds the word while the popover four hundred lines away
 * still ignores the key. A per-popover analysis is not something a regex can
 * do in a file holding several of them.
 *
 * So this asserts the one thing that IS mechanically decidable: whether a
 * component rolls its own document-level dismiss listener at all. Using
 * `useDismiss` gets both halves by construction and cannot drift. The 32 that
 * predate the hook are listed below and may be migrated at leisure — this only
 * refuses a NEW one, where the bug has now been introduced twice.
 */

const ROOT = resolve(__dirname, "../..");

function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { out.push(...tsxUnder(full)); continue; }
    if (e.name.endsWith(".tsx") && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Components that rolled their own outside-click dismiss before useDismiss. */
const LEGACY = new Set([
  "src/components/transcript/CueSelectionMenu.tsx",
  "src/components/EmojiPicker.tsx",
  "src/components/FolderTagMenu.tsx",
  "src/components/LibraryCardMenu.tsx",
  "src/components/NotificationBell.tsx",
  "src/components/RecentSources.tsx",
  "src/components/transcript/RenamePopover.tsx",
  "src/components/ReviewPanel.tsx",
  "src/components/SettingsModal.tsx",
  "src/components/SpeakerColorPicker.tsx",
  "src/components/SpeedControl.tsx",
  "src/components/TranscriptViewer.tsx",
  "src/components/ViewOptions.tsx",
  "src/components/VolumeControl.tsx",
  "src/components/transcript/BadgeIconSheet.tsx",
]);

const rolls = (t: string) =>
  /document\.addEventListener\(\s*"(?:mousedown|pointerdown|click)"/.test(t);

const found = new Set(
  tsxUnder(join(ROOT, "src/components"))
    .filter((f) => rolls(readFileSync(f, "utf8")))
    .map((f) => f.replace(ROOT + "/", "")),
);

describe("click-outside dismissers", () => {
  it("found the ones that exist", () => {
    // A ratchet that matches nothing is a ratchet that holds nothing, and four
    // checks in this repo have already reported success on an empty set.
    expect(found.size, "no outside-click dismissers found — the matcher broke").toBeGreaterThan(8);
  });

  it("adds no new hand-rolled one", () => {
    const added = [...found].filter((f) => !LEGACY.has(f)).sort();
    expect(
      added,
      "use useDismiss(ref, onClose, open) — it gives you Escape too, which is the half that keeps getting forgotten",
    ).toEqual([]);
  });

  it("keeps the legacy list honest as they migrate", () => {
    // An entry that no longer rolls its own is stale permission. Deleting it
    // is what makes the ratchet tighten instead of just holding.
    const stale = [...LEGACY].filter((f) => !found.has(f)).sort();
    expect(stale, "these no longer hand-roll a dismisser; remove them from LEGACY").toEqual([]);
  });
});
