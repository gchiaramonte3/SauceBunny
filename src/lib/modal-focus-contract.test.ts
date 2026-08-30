import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A dialog behind a scrim declares `aria-modal`, and anything that declares it
 * manages focus. Two halves of one promise, and both halves were broken.
 *
 * `aria-modal="true"` tells assistive tech that everything outside the dialog
 * is inert. Five dialogs made that claim with no focus trap and no restore -
 * ReaderRowMenu, ShareDialog, YouTubeAuthModal, NewSpeakerSheet and
 * SpeakerRosterModal - so Tab walked out into the page behind the scrim and
 * closing dropped focus onto <body>. `useModalFocus` already did both jobs;
 * they had simply never been wired to it.
 *
 * The other half is sharper, because in this app the attribute is not only for
 * screen readers: TranscriptViewer gates cmd+F and cmd+G on
 * `[role="dialog"][aria-modal="true"]` matching. Four modals that DID manage
 * focus never declared it - PasteNotesModal, RenameDialog, LibraryQuickLook,
 * TranscriptSearchModal - so pressing cmd+F while renaming a file yanked focus
 * to the transcript search bar behind the dialog. Nothing about that reads as
 * an accessibility problem when you hit it; it reads as the app being haunted.
 *
 * Non-modal `role="dialog"` popovers with no scrim (the emoji picker, the
 * colour picker, the insights popover) are deliberately out of scope. They do
 * not cover the page and trapping focus in one would be worse than not.
 */

const ROOT = resolve(__dirname, "../..");

/**
 * readdirSync, not `globSync` from node:fs. CI pins Node 20 and globSync
 * arrived in 22, so the first version of this file passed on a Node 25 laptop
 * and died in CI with "globSync is not a function". The rest of the contracts
 * walk the tree this way for the same reason.
 */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) tsxFiles(full, out);
    else if (e.name.endsWith(".tsx") && !e.name.includes(".test.")) out.push(relative(ROOT, full));
  }
  return out;
}

const files = tsxFiles(resolve(ROOT, "src"));

/** Every JSX `role="dialog"` attribute, with the opening tag it belongs to. */
function dialogTags(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\brole="dialog"/g)) {
    const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
    // The two ways this string appears WITHOUT being a JSX attribute: as a CSS
    // selector in a querySelector call, and as prose in a comment. Both occur
    // here, and both fooled an earlier version of this scan.
    if (line.includes("querySelector") || line.includes('[role="dialog"]')) continue;
    if (/^\s*(\/\/|\*|\{\/\*)/.test(line)) continue;

    let start = m.index;
    while (start > 0 && !(src[start] === "<" && /[A-Za-z]/.test(src[start + 1] ?? ""))) start--;
    // '>' inside braces belongs to an arrow function in a handler, not the tag.
    let depth = 0;
    let end = start;
    while (end < src.length) {
      const c = src[end];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      end++;
    }
    out.push(src.slice(start, end));
  }
  return out;
}

const isModal = (tag: string) => /aria-modal=\{?["{]?true/.test(tag);

/**
 * Does this file actually CALL the hook, on a line that is not commented out?
 *
 * Two weaker forms of this check both passed a break-test that commented the
 * call out: `includes("useModalFocus")` matches the import line, and
 * `/useModalFocus\s*\(/` matches inside the comment itself. Neither would have
 * caught a deleted call, which is the regression this exists to catch.
 */
function callsModalFocus(src: string): boolean {
  return src.split("\n").some((line) => {
    const at = line.indexOf("useModalFocus(");
    if (at < 0) return false;
    const before = line.slice(0, at);
    return !before.includes("//") && !before.trimStart().startsWith("*");
  });
}

const all = files.map((f) => {
  const src = readFileSync(resolve(ROOT, f), "utf8");
  return { file: f, src, tags: dialogTags(src) };
});
const withDialogs = all.filter((f) => f.tags.length > 0);
const modalFiles = withDialogs.filter((f) => f.tags.some(isModal));

describe("modal dialogs", () => {
  it("are found by the scan at all", () => {
    // The canary. Everything below is a filter over this list, and a scan that
    // silently matches nothing passes forever while guarding nothing.
    expect(withDialogs.length, "no role=dialog found - the scan broke").toBeGreaterThan(10);
    expect(modalFiles.length, "no aria-modal dialogs found - the scan broke").toBeGreaterThan(10);
  });

  it("trap and restore focus", () => {
    // A CALL, not a mention. Checking `includes("useModalFocus")` matches the
    // import line, so a file that imports the hook and never calls it passed -
    // which is precisely what deleting the call leaves behind, and precisely
    // what a new dialog added to a file that already imports it looks like.
    // The break-test caught this; reading the assertion did not.
    const bad = modalFiles.filter((f) => !callsModalFocus(f.src)).map((f) => f.file);
    expect(bad, "aria-modal dialogs with no focus trap or restore").toEqual([]);
  });

  it("give the trap something to focus", () => {
    // The hook focuses the ref'd container on open, and focus() on an element
    // with no tabindex is a no-op - the trap would have no anchor. The ref may
    // sit on an inner box rather than the role="dialog" element itself (the
    // palette and the shortcut sheet put the role on the scrim), so this is a
    // per-file check rather than a per-tag one.
    const bad = modalFiles
      .filter((f) => !/tabIndex=\{-1\}/.test(f.src) || !/ref=\{/.test(f.src))
      .map((f) => f.file);
    expect(bad, "aria-modal dialogs whose container cannot take focus").toEqual([]);
  });

  it("have an accessible name", () => {
    // A dialog announces as its NAME. Without one a screen reader says
    // "dialog" and stops, leaving the user to work out which one opened -
    // and two of these were the rename and DELETE confirmations for a
    // project, which are the dialogs where knowing matters most.
    //
    // This guard was one line away from catching it the whole time: it
    // already parses these very tags, brace-aware, for four other
    // properties. It simply never asked.
    //
    // Per TAG, not per file: a file can hold several dialogs and only some
    // of them named, which a per-file check reads as fine.
    const bad: string[] = [];
    for (const f of modalFiles) {
      for (const tag of f.tags.filter(isModal)) {
        if (/aria-label(ledby)?=/.test(tag)) continue;
        bad.push(f.file);
      }
    }
    expect(bad, "aria-modal dialog with neither aria-label nor aria-labelledby").toEqual([]);
  });

  it("declare aria-modal whenever they sit behind a scrim", () => {
    // The other direction, and the one with a non-obvious cost: the attribute
    // is what TranscriptViewer's cmd+F / cmd+G guard reads. A modal that omits
    // it does not just mislead a screen reader, it lets those keys act on the
    // transcript behind the dialog.
    const bad = withDialogs
      .filter((f) => /className="[^"]*(backdrop|scrim)/.test(f.src))
      .filter((f) => !f.tags.some(isModal))
      .map((f) => f.file);
    expect(bad, "dialogs behind a scrim that never declare aria-modal").toEqual([]);
  });
});
