import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A global shortcut claimed by a component that is mounted TWICE.
 *
 * TranscriptViewer renders in two places at once — the reader view and the
 * drawer's transcript tab — and both keep-alive wrappers keep the loser
 * MOUNTED rather than unmounting it (`hidden={shownTab !== "transcript"}` in
 * QueueDrawer, `hidden={activeView !== ...}` on every view in App). So a
 * `window.addEventListener("keydown")` inside it runs TWICE for one keystroke,
 * and one of those runs belongs to a copy nobody can see.
 *
 * That already happened. The ⌘G handler says so in its own comment: without
 * the gate, ⌘G advanced the HIDDEN instance's match cursor and switched its
 * auto-scroll off, and nothing switches auto-scroll back on — the karaoke
 * follow silently stopped working, in a component the user was not looking at,
 * from a keystroke aimed at the one they were.
 *
 * Both handlers now check that their own root is not inside a `[hidden]` or
 * `aria-hidden="true"` subtree. Nothing tested that, which is the gap here:
 * a fix for a real bug, in a file of 2,000+ lines, that any refactor could
 * lift out silently because the symptom appears in the OTHER instance.
 *
 * WHAT THIS IS NOT: a behavioural test. The honest version drives two mounted
 * instances in a browser and presses ⌘G, and it is not written because the e2e
 * mock has no transcript-content path — adding one means reworking the shared
 * mock that all 105 specs depend on. This pins the code property instead, which
 * is weaker: it proves the gate is present, not that it works. If the mock ever
 * grows a seeded transcript, replace this with the real thing.
 */

const ROOT = resolve(__dirname, "../..");
const src = readFileSync(join(ROOT, "src/components/TranscriptViewer.tsx"), "utf8");

/** Bodies of handlers registered as global keydown listeners. */
function globalKeyHandlers(s: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  for (const reg of s.matchAll(/(?:document|window)\.addEventListener\(\s*"keydown"\s*,\s*(\w+)/g)) {
    const name = reg[1];
    // The NEAREST declaration above this registration, not the first in the
    // file. All three handlers here are called `onKey`, so taking the first
    // match returned the ⌘F body three times over and the contract examined
    // ⌘G's code never once — it passed a break-test that removed ⌘G's gate.
    // Caught by that break-test, which is the only reason this reads correctly.
    const decl = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`, "g");
    const before = s.slice(0, reg.index);
    let m: RegExpExecArray | null = null;
    for (let hit = decl.exec(before); hit; hit = decl.exec(before)) m = hit;
    if (!m) continue;
    let i = m.index + m[0].length - 1;
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) break;
    }
    out.push({ name, body: s.slice(m.index, i) });
  }
  return out;
}

const GATE = /closest\("\[hidden\]"\)|closest\('\[aria-hidden="true"\]'\)/;
/** A chord handler claims a global shortcut rather than a plain key. */
const CHORD = /\.metaKey|\.ctrlKey/;

const handlers = globalKeyHandlers(src);

describe("TranscriptViewer's global shortcuts", () => {
  it("found the handlers to check", () => {
    // The canary. Every assertion below is "each handler satisfies X", which is
    // vacuously true of an empty list — the exact way four checks in this repo
    // have reported success while scanning nothing.
    expect(handlers.length, "no global keydown handlers parsed out of TranscriptViewer")
      .toBeGreaterThanOrEqual(3);
    expect(
      handlers.filter((h) => CHORD.test(h.body)).length,
      "no ⌘-chord handler found — the matcher broke, not the code",
    ).toBeGreaterThanOrEqual(2);
  });

  it("gates every ⌘-chord on the instance actually being visible", () => {
    // The rule. A chord is claimed app-wide, so the hidden twin receives it too
    // and acts on state the user cannot see being changed.
    const ungated = handlers
      .filter((h) => CHORD.test(h.body))
      .filter((h) => !GATE.test(h.body))
      .map((h) => h.name);
    expect(
      ungated,
      "a ⌘-shortcut in a twice-mounted component with no [hidden]/aria-hidden check: the copy in the closed drawer will act on it too",
    ).toEqual([]);
  });

  it("also keeps them from acting behind a modal scrim", () => {
    // Same family of bug, same two handlers: cycling matches (and its scroll)
    // while Settings or the palette holds focus acts behind the scrim.
    const unscrimmed = handlers
      .filter((h) => CHORD.test(h.body))
      .filter((h) => !/role="dialog"\]\[aria-modal/.test(h.body))
      .map((h) => h.name);
    expect(unscrimmed, "a ⌘-shortcut that fires while a modal dialog is open").toEqual([]);
  });

  it("records that the keep-alive wrappers still exist", () => {
    // The gate is only necessary because the losers stay mounted. If the
    // drawer and views ever switch to unmounting, this whole contract becomes
    // dead weight and should be deleted rather than left asserting a rule with
    // no hazard behind it.
    const drawer = readFileSync(join(ROOT, "src/components/QueueDrawer.tsx"), "utf8");
    const app = readFileSync(join(ROOT, "src/App.tsx"), "utf8");
    expect(drawer, "the drawer no longer keeps hidden tabs mounted").toMatch(/hidden=\{shownTab !== /);
    expect(app, "views no longer keep-alive").toMatch(/hidden=\{activeView !== /);
  });
});
